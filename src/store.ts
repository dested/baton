import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { StateFile, type Message, type Pairing, type PairingView } from './schema.ts';

type Waiter = () => void;

/** Pairings, persisted to state.json (0600) after every change, with in-memory waiters for long polls. */
export class Store {
  private pairings = new Map<string, Pairing>();
  private instructionWaiters = new Map<string, Set<Waiter>>();
  private reportWaiters = new Map<string, Set<Waiter>>();
  private browserWaits = new Map<string, number>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = StateFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) throw new Error(`${file} is not a baton state file: ${parsed.error.message}. Move it aside and restart the relay.`);
      for (const p of parsed.data.pairings) this.pairings.set(p.id, p);
    }
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, pairings: [...this.pairings.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  create(name: string): Pairing {
    let id = '';
    do id = randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').toLowerCase().slice(0, 6);
    while (this.pairings.has(id));
    const p: Pairing = {
      id,
      name,
      token: randomBytes(24).toString('base64url'),
      createdAt: new Date().toISOString(),
      closedAt: null,
      messages: [],
      cliCursor: 0,
      browserSeenSeq: 0,
      browserLastAt: null,
    };
    this.pairings.set(id, p);
    this.save();
    return p;
  }

  get(id: string): Pairing | undefined {
    return this.pairings.get(id);
  }

  list(): Pairing[] {
    return [...this.pairings.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  addInstruction(p: Pairing, text: string): Message {
    const m: Message = { kind: 'instruction', seq: lastSeq(p, 'instruction') + 1, at: new Date().toISOString(), text };
    p.messages.push(m);
    this.save();
    fire(this.instructionWaiters, p.id);
    return m;
  }

  addReport(p: Pairing, text: string, about: number): Message {
    const m: Message = { kind: 'report', seq: lastSeq(p, 'report') + 1, at: new Date().toISOString(), text, about };
    p.messages.push(m);
    this.save();
    fire(this.reportWaiters, p.id);
    return m;
  }

  close(p: Pairing): void {
    p.closedAt = new Date().toISOString();
    this.save();
    fire(this.instructionWaiters, p.id);
    fire(this.reportWaiters, p.id);
  }

  markBrowserSeen(p: Pairing): void {
    p.browserSeenSeq = lastSeq(p, 'instruction');
    p.browserLastAt = new Date().toISOString();
    this.save();
  }

  setCliCursor(p: Pairing, seq: number): void {
    if (seq > p.cliCursor) {
      p.cliCursor = seq;
      this.save();
    }
  }

  /** Resolves when an instruction newer than `after` exists, the pairing closes, or ms pass. */
  async waitInstruction(p: Pairing, after: number, ms: number): Promise<'ready' | 'timeout' | 'closed'> {
    this.browserWaits.set(p.id, (this.browserWaits.get(p.id) ?? 0) + 1);
    try {
      return await waitFor(this.instructionWaiters, p.id, ms, () =>
        p.closedAt !== null ? 'closed' : lastSeq(p, 'instruction') > after ? 'ready' : null,
      );
    } finally {
      this.browserWaits.set(p.id, (this.browserWaits.get(p.id) ?? 1) - 1);
    }
  }

  /** Resolves when a report newer than `after` exists, the pairing closes, or ms pass. */
  waitReport(p: Pairing, after: number, ms: number): Promise<'ready' | 'timeout' | 'closed'> {
    return waitFor(this.reportWaiters, p.id, ms, () =>
      lastSeq(p, 'report') > after ? 'ready' : p.closedAt !== null ? 'closed' : null,
    );
  }

  view(p: Pairing): PairingView {
    const instructions = p.messages.filter((m) => m.kind === 'instruction');
    const reports = p.messages.filter((m) => m.kind === 'report');
    const lastInstruction = instructions.at(-1) ?? null;
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      closedAt: p.closedAt,
      instructions: instructions.length,
      reports: reports.length,
      unreadReports: reports.filter((r) => r.seq > p.cliCursor).length,
      cliCursor: p.cliCursor,
      lastInstruction,
      lastReport: reports.at(-1) ?? null,
      browserSeenSeq: p.browserSeenSeq,
      browserLastAt: p.browserLastAt,
      browserWaiting: (this.browserWaits.get(p.id) ?? 0) > 0,
      pickedUp: lastInstruction !== null && p.browserSeenSeq >= lastInstruction.seq,
    };
  }
}

export function lastSeq(p: Pairing, kind: Message['kind']): number {
  for (let i = p.messages.length - 1; i >= 0; i--) {
    const m = p.messages[i];
    if (m !== undefined && m.kind === kind) return m.seq;
  }
  return 0;
}

export function nextReport(p: Pairing, after: number): Message | undefined {
  return p.messages.find((m) => m.kind === 'report' && m.seq > after);
}

function fire(map: Map<string, Set<Waiter>>, id: string): void {
  const set = map.get(id);
  if (!set) return;
  map.delete(id);
  for (const w of set) w();
}

function waitFor<T extends string>(
  map: Map<string, Set<Waiter>>,
  id: string,
  ms: number,
  check: () => T | null,
): Promise<T | 'timeout'> {
  const now = check();
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = () => {
      const r = check();
      if (r !== null) {
        clearTimeout(timer);
        resolve(r);
      } else {
        add();
      }
    };
    const add = (): void => {
      let set = map.get(id);
      if (!set) map.set(id, (set = new Set()));
      set.add(waiter);
    };
    add();
    timer = setTimeout(() => {
      map.get(id)?.delete(waiter);
      resolve('timeout');
    }, ms);
  });
}
