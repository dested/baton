#!/usr/bin/env bun
// baton: the Claude Code side of the relay to Claude in Chrome. Run baton --help.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { batonHome, batonPort, keyPath, readKey } from '../src/config.ts';
import { ApiError, Message, NewPairingResult, PairingView, SendResult, WaitResult } from '../src/schema.ts';

const EXIT = { ok: 0, usage: 1, relay: 2, timeout: 3, closed: 4 } as const;
const DEFAULT_TIMEOUT_S = 220;
const DEFAULT_MAX_CHARS = 3000;

const HELP = `baton: hand tasks to Claude in Chrome (the user's signed-in browser) and get reports back.

  baton new [--name <t>] [--print] [--no-clip]   pairing + paste prompt (copied to the clipboard; --print shows it)
  baton ask <id> <text…>                         send an instruction, block until its report arrives
  baton send <id> <text…>                        send without waiting       (text: args, --file <path>, or - for stdin)
  baton wait <id> [--after <n>]                  block until the next unread report
  baton show <id> [n] [--full]                   report n again (default: the last)
  baton status <id> · baton list [--all]         one line per pairing
  baton prompt <id> [--relay] [--clip]           the paste prompt again (--relay: fallback, user pastes each step)
  baton close <id> [--reason <t>]                send STOP and close
  baton doctor                                   relay, key file, service

  --timeout <s>   ask/wait limit, default ${DEFAULT_TIMEOUT_S}
  --max <n>       report budget in chars, default ${DEFAULT_MAX_CHARS} (head and tail kept); --full for all of it
  --clip          send/ask/prompt: also copy the text to the clipboard
  --json          one JSON object on stdout

exit: 0 ok · 1 usage or unknown pairing · 2 relay down or key problem · 3 timed out · 4 pairing closed
relay: http://localhost:${batonPort()} · key: ${keyPath(batonHome())} · env: BATON_PORT, BATON_HOME`;

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly next: string,
  ) {
    super(message);
  }
}

type Flags = {
  json: boolean;
  clip: boolean;
  noClip: boolean;
  print: boolean;
  relay: boolean;
  all: boolean;
  full: boolean;
  max: number;
  timeout: number;
  name?: string;
  after?: number;
  file?: string;
  reason?: string;
};

function parseArgs(argv: string[]): { cmd: string | undefined; pos: string[]; flags: Flags } {
  const flags: Flags = { json: false, clip: false, noClip: false, print: false, relay: false, all: false, full: false, max: DEFAULT_MAX_CHARS, timeout: DEFAULT_TIMEOUT_S };
  const pos: string[] = [];
  const need = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new CliError(`${name} needs a value`, EXIT.usage, 'baton --help');
    return v;
  };
  const num = (v: string, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new CliError(`${name} wants a non-negative number, got ${v}`, EXIT.usage, 'baton --help');
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--json') flags.json = true;
    else if (a === '--clip') flags.clip = true;
    else if (a === '--no-clip') flags.noClip = true;
    else if (a === '--print') flags.print = true;
    else if (a === '--relay') flags.relay = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--help' || a === '-h') pos.unshift('help');
    else if (a === '--name') flags.name = need(i++, a);
    else if (a === '--file') flags.file = need(i++, a);
    else if (a === '--reason') flags.reason = need(i++, a);
    else if (a === '--timeout') flags.timeout = num(need(i++, a), a);
    else if (a === '--max') flags.max = Math.floor(num(need(i++, a), a));
    else if (a === '--after') flags.after = Math.floor(num(need(i++, a), a));
    else if (a.startsWith('--')) throw new CliError(`unknown flag ${a}`, EXIT.usage, 'baton --help');
    else pos.push(a);
  }
  return { cmd: pos.shift(), pos, flags };
}

const base = (): string => `http://127.0.0.1:${batonPort()}`;
const DOWN_NEXT = 'start the relay (systemctl --user start baton, or bun server.ts in the baton repo), then baton doctor';

// Where loopback is mirrored (WSL), a connect to a closed port can hang instead of being refused,
// so a short health probe tells "relay down" apart before a long poll starts.
let probed: Promise<void> | null = null;
function ensureUp(): Promise<void> {
  probed ??= fetch(base() + '/healthz', { signal: AbortSignal.timeout(2500) }).then(
    (r) => {
      if (!r.ok) throw new CliError(`relay at ${base()} answered ${r.status}`, EXIT.relay, 'baton doctor');
    },
    (e: unknown) => {
      throw new CliError(`relay not reachable at ${base()} (${e instanceof Error ? e.message : String(e)})`, EXIT.relay, DOWN_NEXT);
    },
  );
  return probed;
}

async function call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  await ensureUp();
  const key = readKey(batonHome());
  if (key === null) throw new CliError(`no CLI key at ${keyPath(batonHome())}`, EXIT.relay, 'the relay writes it on first start; if the relay runs elsewhere (WSL), set BATON_HOME to its config dir');
  let res: Response;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new CliError(`relay request failed (${e instanceof Error ? e.message : String(e)})`, EXIT.relay, DOWN_NEXT);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(data);
    const code = res.status === 401 ? EXIT.relay : res.status === 409 ? EXIT.closed : EXIT.usage;
    if (err.success) throw new CliError(err.data.error.message, code, err.data.error.next);
    throw new CliError(`relay answered ${res.status}`, EXIT.relay, 'baton doctor');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CliError(`unexpected relay answer: ${parsed.error.message}`, EXIT.relay, 'restart the relay so it matches this CLI');
  return parsed.data;
}

async function readText(pos: string[], flags: Flags): Promise<string> {
  let text: string;
  if (flags.file !== undefined) text = await Bun.file(flags.file).text();
  else if (pos.length === 1 && pos[0] === '-') text = await Bun.stdin.text();
  else text = pos.join(' ');
  if (text.trim() === '') throw new CliError('no instruction text', EXIT.usage, 'pass it as arguments, --file <path>, or - for stdin');
  return text;
}

const BOM = String.fromCharCode(0xfeff);

function isWsl(): boolean {
  try {
    return process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Copies text to the desktop clipboard. Returns false when there is no clipboard tool. */
async function toClipboard(text: string): Promise<boolean> {
  const windowsClip = process.platform === 'win32' ? 'clip' : isWsl() ? 'clip.exe' : null;
  const candidates: { cmd: string[]; data: Uint8Array }[] = windowsClip
    ? [{ cmd: [windowsClip], data: Buffer.from(BOM + text.replace(/\r?\n/g, '\r\n'), 'utf16le') }]
    : process.platform === 'darwin'
      ? [{ cmd: ['pbcopy'], data: Buffer.from(text) }]
      : [
          { cmd: ['wl-copy'], data: Buffer.from(text) },
          { cmd: ['xclip', '-selection', 'clipboard'], data: Buffer.from(text) },
        ];
  for (const c of candidates) {
    try {
      const proc = Bun.spawn(c.cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
      proc.stdin.write(c.data);
      await proc.stdin.end();
      if ((await proc.exited) === 0) return true;
    } catch {
      // not installed: try the next one
    }
  }
  return false;
}

const PairingOnly = z.object({ pairing: PairingView });
const PairingList = z.object({ pairings: z.array(PairingView) });
const ReportOnly = z.object({ pairing: PairingView, report: Message });
const Health = z.object({ ok: z.literal(true), version: z.string() });

function print(flags: Flags, obj: unknown, text: string): void {
  console.log(flags.json ? JSON.stringify(obj) : text);
}

function line(p: PairingView): string {
  const parts = [`${p.id} ${p.closedAt !== null ? 'closed' : 'open'} "${p.name}"`];
  parts.push(p.lastInstruction ? `${p.instructions} instr (#${p.lastInstruction.seq} ${p.pickedUp ? 'picked up' : 'not picked up'})` : '0 instr');
  parts.push(`${p.reports} reports (${p.unreadReports} unread)`);
  parts.push(p.browserWaiting ? 'browser waiting' : p.browserLastAt ? `browser seen ${p.browserLastAt.slice(11, 19)}Z` : 'browser never opened the page');
  return parts.join(' · ');
}

/** Head and tail of a long report, bx-style: the budget is in characters, the cut says how to get the rest. */
function clip(text: string, max: number, more: string): { text: string; trimmed: number } {
  if (max <= 0 || text.length <= max) return { text, trimmed: 0 };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const trimmed = text.length - max;
  return { text: `${text.slice(0, head)}\n… [${trimmed} chars cut: ${more}] …\n${text.slice(text.length - tail)}`, trimmed };
}

function showReport(flags: Flags, id: string, r: Message, p: PairingView, extra: Record<string, unknown> = {}): void {
  const c = clip(r.text, flags.full ? 0 : flags.max, `baton show ${id} ${r.seq} --full`);
  const instr = p.lastInstruction !== null && p.lastInstruction.seq === r.about ? p.lastInstruction : null;
  const secs = instr ? Math.round((Date.parse(r.at) - Date.parse(instr.at)) / 1000) : null;
  const head = [`#${r.seq} report${r.about ? ` on #${r.about}` : ''}`, secs !== null ? `${secs}s` : null, `${r.text.length} chars`]
    .filter((x) => x !== null)
    .join(' · ');
  print(flags, { ...extra, id, seq: r.seq, about: r.about ?? null, at: r.at, chars: r.text.length, trimmed: c.trimmed, text: c.text }, `${head}\n${c.text}`);
}

async function waitLoop(id: string, flags: Flags, after: number | undefined): Promise<number> {
  const deadline = Date.now() + flags.timeout * 1000;
  for (;;) {
    const slice = Math.min(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), 90);
    const q = new URLSearchParams({ timeout: String(slice) });
    if (after !== undefined) q.set('after', String(after));
    const r = await call(WaitResult, 'GET', `/api/pairings/${encodeURIComponent(id)}/wait?${q}`, undefined, (slice + 20) * 1000);
    if (r.status === 'report') {
      showReport(flags, id, r.report, r.pairing, r.skipped > 0 ? { skipped: r.skipped } : {});
      return EXIT.ok;
    }
    if (r.status === 'closed') {
      print(flags, { status: 'closed', id }, `closed: ${id} won't report again · next: baton new`);
      return EXIT.closed;
    }
    if (Date.now() >= deadline) {
      const p = r.pairing;
      const answered = p.lastInstruction !== null && p.lastReport !== null && (p.lastReport.about ?? 0) >= p.lastInstruction.seq;
      const why = answered
        ? 'last instruction already reported'
        : !p.pickedUp
          ? 'browser has not picked up the last instruction (user may need to press "Wait for the next instruction")'
          : p.browserWaiting
            ? 'browser is waiting, so it may have skipped the report'
            : 'browser picked it up and is still working';
      print(flags, { status: 'timeout', id, reason: why, pairing: p }, `timeout ${flags.timeout}s · ${why} · next: baton wait ${id}`);
      return EXIT.timeout;
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const { cmd, pos, flags } = parseArgs(argv);
  const id = (): string => {
    const v = pos.shift();
    if (v === undefined) throw new CliError(`${cmd} needs a pairing id`, EXIT.usage, 'baton list');
    return v;
  };
  const path = (pid: string, rest = ''): string => `/api/pairings/${encodeURIComponent(pid)}${rest}`;
  switch (cmd) {
    case undefined:
    case 'help':
      console.log(HELP);
      return EXIT.ok;
    case 'new': {
      const r = await call(NewPairingResult, 'POST', '/api/pairings', flags.name ? { name: flags.name } : {});
      const copied = flags.noClip ? false : await toClipboard(r.prompt);
      const showPrompt = flags.print || !copied;
      print(
        flags,
        { id: r.pairing.id, name: r.pairing.name, url: r.url, clipboard: copied, prompt: r.prompt },
        `${r.pairing.id} "${r.pairing.name}" · ${r.url} · ${copied ? 'paste prompt is on the clipboard' : 'paste prompt below'}${showPrompt ? `\n${r.prompt}` : ''}`,
      );
      return EXIT.ok;
    }
    case 'prompt': {
      const r = await call(NewPairingResult, 'GET', path(id(), '/prompt'));
      const text = flags.relay ? r.relayPrompt : r.prompt;
      const copied = flags.clip ? await toClipboard(text) : false;
      print(flags, { id: r.pairing.id, url: r.url, relay: flags.relay, clipboard: copied, prompt: text }, text);
      return EXIT.ok;
    }
    case 'send':
    case 'ask': {
      const pid = id();
      const text = await readText(pos, flags);
      const before = await call(PairingOnly, 'GET', path(pid));
      const r = await call(SendResult, 'POST', path(pid, '/send'), { text });
      const copied = flags.clip ? await toClipboard(text) : false;
      if (cmd === 'send') {
        print(flags, { id: pid, seq: r.instruction.seq, clipboard: copied }, `sent #${r.instruction.seq} → ${pid}${copied ? ' (on the clipboard)' : ''}`);
        return EXIT.ok;
      }
      return waitLoop(pid, flags, Math.max(before.pairing.cliCursor, before.pairing.reports));
    }
    case 'wait':
      return waitLoop(id(), flags, flags.after);
    case 'show': {
      const pid = id();
      const n = pos.shift();
      if (n !== undefined && !/^\d+$/.test(n)) throw new CliError(`report number wanted, got ${n}`, EXIT.usage, 'baton show <id> [n]');
      const r = await call(ReportOnly, 'GET', path(pid, `/report${n !== undefined ? `/${n}` : ''}`));
      showReport(flags, pid, r.report, r.pairing);
      return EXIT.ok;
    }
    case 'status': {
      const r = await call(PairingOnly, 'GET', path(id()));
      print(flags, r.pairing, line(r.pairing));
      return EXIT.ok;
    }
    case 'list': {
      const r = await call(PairingList, 'GET', '/api/pairings');
      const rows = r.pairings.filter((p) => flags.all || p.closedAt === null);
      print(flags, { pairings: rows }, rows.length ? rows.map(line).join('\n') : `no ${flags.all ? '' : 'open '}pairings · next: baton new --name "<task>"`);
      return EXIT.ok;
    }
    case 'close': {
      const r = await call(PairingOnly, 'POST', path(id(), '/close'), flags.reason ? { reason: flags.reason } : {});
      print(flags, { id: r.pairing.id, closedAt: r.pairing.closedAt }, `closed ${r.pairing.id} · the page shows STOP`);
      return EXIT.ok;
    }
    case 'doctor': {
      const checks: { check: string; ok: boolean; detail: string }[] = [];
      try {
        const res = await fetch(base() + '/healthz', { signal: AbortSignal.timeout(2500) });
        const h = Health.safeParse(await res.json());
        checks.push({ check: 'relay', ok: h.success, detail: h.success ? `${base()} v${h.data.version}` : `${base()} answered ${res.status}` });
      } catch (e) {
        checks.push({ check: 'relay', ok: false, detail: `${base()} not reachable (${e instanceof Error ? e.message : String(e)}): ${DOWN_NEXT}` });
      }
      const kp = keyPath(batonHome());
      if (!existsSync(kp)) checks.push({ check: 'key', ok: false, detail: `${kp} missing: the relay writes it on first start; set BATON_HOME if the relay runs elsewhere` });
      else if (process.platform === 'win32') checks.push({ check: 'key', ok: true, detail: kp });
      else {
        const mode = statSync(kp).mode & 0o777;
        checks.push({ check: 'key', ok: mode === 0o600, detail: `${kp} mode ${mode.toString(8)}${mode === 0o600 ? '' : ': chmod 600 it'}` });
      }
      if (process.platform === 'linux') {
        try {
          const active = Bun.spawnSync(['systemctl', '--user', 'is-active', 'baton']).stdout.toString().trim();
          checks.push({ check: 'service', ok: active === 'active', detail: `systemd --user baton: ${active || 'unknown'}${active === 'active' ? '' : ' (sh scripts/install-service.sh in the baton repo)'}` });
        } catch {
          // no systemd: the relay is run some other way
        }
      }
      const ok = checks.every((c) => c.ok);
      print(flags, { ok, checks }, checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.check}: ${c.detail}`).join('\n'));
      return ok ? EXIT.ok : EXIT.relay;
    }
    default:
      throw new CliError(`unknown command ${cmd}`, EXIT.usage, 'baton --help');
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: { message: e.message, next: e.next, exitCode: e.code } }));
  else console.error(`baton: ${e.message} · next: ${e.next}`);
  process.exitCode = e.code;
}
