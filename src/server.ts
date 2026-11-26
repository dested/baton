import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ensureHome, loadOrCreateKey, statePath } from './config.ts';
import { messagePage, pairingPage, type PageNotice } from './page.ts';
import { pastePrompt, relayPrompt } from './prompt.ts';
import { Store, lastSeq, nextReport } from './store.ts';
import type { Pairing } from './schema.ts';

export const VERSION = '0.1.0';

export type ServerOptions = {
  port: number;
  home: string;
  /** how long the page's "Wait for the next instruction" holds before "Still waiting" (default 50 s) */
  browserWaitMs?: number;
  /** the cap on one CLI long-poll request (default 90 s; the CLI loops) */
  cliWaitCapMs?: number;
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function apiError(status: number, code: string, message: string, next: string): Response {
  return json({ error: { code, message, next } }, status);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const NewBody = z.object({ name: z.string().trim().min(1).max(80).optional() });
const SendBody = z.object({ text: z.string().min(1).max(100_000) });
const CloseBody = z.object({ reason: z.string().max(2000).optional() });

export const STOP_TEXT = 'STOP';

export function startServer(opts: ServerOptions) {
  ensureHome(opts.home);
  const key = loadOrCreateKey(opts.home);
  const store = new Store(statePath(opts.home));
  const browserWaitMs = opts.browserWaitMs ?? 50_000;
  const cliWaitCapMs = opts.cliWaitCapMs ?? 90_000;
  let port = opts.port;

  const allowedHost = (host: string | null): boolean =>
    host !== null && [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host.toLowerCase());

  const pageUrl = (p: Pairing): string => `http://localhost:${port}/c/${p.id}?t=${p.token}`;

  async function api(req: Request, url: URL): Promise<Response> {
    // CLI only: a browser always sends Origin on a POST and can't set Authorization cross-site.
    if (req.headers.get('origin') !== null) {
      return apiError(403, 'browser_origin', 'The API is for the baton CLI, not for web pages.', 'Use the baton CLI.');
    }
    const auth = req.headers.get('authorization') ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(given, key)) {
      return apiError(401, 'bad_key', 'Missing or wrong CLI key.', `The key is in ${opts.home}/cli.key; run baton as the same user as the relay, or point BATON_HOME at the relay's config dir.`);
    }
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'pairings', id?, action?]
    if (parts[1] !== 'pairings') return apiError(404, 'not_found', `No API route ${url.pathname}.`, 'Run baton --help.');
    const id = parts[2];
    const action = parts[3];

    if (id === undefined) {
      if (req.method === 'GET') return json({ pairings: store.list().map((p) => store.view(p)) });
      if (req.method === 'POST') {
        const body = NewBody.safeParse(await req.json().catch(() => ({})));
        if (!body.success) return apiError(400, 'bad_body', body.error.message, 'Pass --name with at most 80 characters.');
        const p = store.create(body.data.name ?? `pairing ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
        const u = pageUrl(p);
        return json({ pairing: store.view(p), url: u, prompt: pastePrompt(u), relayPrompt: relayPrompt(u) });
      }
      return apiError(405, 'method', 'GET or POST.', 'Run baton --help.');
    }

    const p = store.get(id);
    if (!p) return apiError(404, 'no_pairing', `No pairing ${id}.`, 'Run baton list to see pairings, or baton new to make one.');

    if (action === undefined && req.method === 'GET') return json({ pairing: store.view(p) });
    if (action === 'prompt' && req.method === 'GET') {
      const u = pageUrl(p);
      return json({ pairing: store.view(p), url: u, prompt: pastePrompt(u), relayPrompt: relayPrompt(u) });
    }
    if (action === 'report' && req.method === 'GET') {
      const seqRaw = parts[4] ?? '';
      const want = /^\d+$/.test(seqRaw) ? Number(seqRaw) : lastSeq(p, 'report');
      const m = p.messages.find((x) => x.kind === 'report' && x.seq === want);
      if (!m) return apiError(404, 'no_report', `Pairing ${id} has no report #${want}.`, `Run baton status ${id}.`);
      return json({ pairing: store.view(p), report: m });
    }
    if (action === 'send' && req.method === 'POST') {
      if (p.closedAt !== null) return apiError(409, 'closed', `Pairing ${id} is closed.`, 'Run baton new for a fresh pairing.');
      const body = SendBody.safeParse(await req.json().catch(() => null));
      if (!body.success) return apiError(400, 'bad_body', body.error.message, 'Send a non-empty instruction text.');
      const m = store.addInstruction(p, body.data.text);
      return json({ pairing: store.view(p), instruction: m });
    }
    if (action === 'wait' && req.method === 'GET') {
      const afterRaw = url.searchParams.get('after');
      const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : p.cliCursor;
      const tRaw = Number(url.searchParams.get('timeout') ?? '0');
      const ms = Math.max(0, Math.min(Number.isFinite(tRaw) ? tRaw * 1000 : 0, cliWaitCapMs));
      const r = await store.waitReport(p, after, ms);
      if (r === 'ready') {
        const report = nextReport(p, after);
        if (report) {
          const skipped = p.messages.filter((m) => m.kind === 'report' && m.seq > p.cliCursor && m.seq < report.seq).length;
          store.setCliCursor(p, report.seq);
          return json({ status: 'report', report, skipped, pairing: store.view(p) });
        }
      }
      return json({ status: r === 'closed' ? 'closed' : 'timeout', pairing: store.view(p) });
    }
    if (action === 'close' && req.method === 'POST') {
      const body = CloseBody.safeParse(await req.json().catch(() => ({})));
      if (p.closedAt === null) {
        const reason = body.success && body.data.reason ? `\n\n${body.data.reason}` : '';
        store.addInstruction(p, `${STOP_TEXT}\n\nThe Claude Code session closed this bridge. Stop all work now, do nothing more in other tabs, and tell the user in the chat that you stopped.${reason}`);
        store.close(p);
      }
      return json({ pairing: store.view(p) });
    }
    return apiError(404, 'not_found', `No API route ${req.method} ${url.pathname}.`, 'Run baton --help.');
  }

  async function browser(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean); // ['c', id, action?]
    const id = parts[1] ?? '';
    const action = parts[2];
    const p = store.get(id);
    let token = url.searchParams.get('t') ?? '';
    // Forms post application/x-www-form-urlencoded (the page has no file inputs).
    const form = req.method === 'POST' ? new URLSearchParams(await req.text().catch(() => '')) : null;
    const ft = form?.get('t');
    if (typeof ft === 'string') token = ft;
    if (!p || !safeEqual(token, p.token)) {
      return html(messagePage('Wrong bridge link', 'This link has a wrong or missing token, or the pairing does not exist. Stop, and ask the user for the bridge link again.'), 403);
    }

    if (action === undefined && req.method === 'GET') {
      const sent = url.searchParams.get('sent');
      const notice: PageNotice | null =
        sent !== null && /^\d+$/.test(sent) ? `Report #${sent} sent. Now press "Wait for the next instruction".` : null;
      store.markBrowserSeen(p);
      return html(pairingPage(p, notice));
    }
    if (action === 'wait' && req.method === 'GET') {
      const afterRaw = url.searchParams.get('after') ?? '';
      const after = /^\d+$/.test(afterRaw) ? Number(afterRaw) : lastSeq(p, 'instruction');
      const r = await store.waitInstruction(p, after, browserWaitMs);
      store.markBrowserSeen(p);
      const notice: PageNotice | null =
        r === 'ready'
          ? `New instruction #${lastSeq(p, 'instruction')}. Do it in another tab, then send your report.`
          : r === 'timeout'
            ? 'Still waiting, press again: no new instruction yet.'
            : null;
      return html(pairingPage(p, notice));
    }
    if (action === 'report' && req.method === 'POST') {
      if (p.closedAt !== null) return html(pairingPage(p, null), 409);
      const text = form?.get('report');
      const aboutRaw = form?.get('about');
      if (typeof text !== 'string' || text.trim() === '') {
        return html(pairingPage(p, 'The report was empty. Type what happened into "Your report", then press "Send report".'), 400);
      }
      const about = typeof aboutRaw === 'string' && /^\d+$/.test(aboutRaw) ? Number(aboutRaw) : 0;
      const m = store.addReport(p, text.slice(0, 100_000), about);
      return new Response(null, {
        status: 303,
        headers: { ...SECURITY_HEADERS, Location: `/c/${p.id}?t=${encodeURIComponent(p.token)}&sent=${m.seq}` },
      });
    }
    return html(messagePage('Not found', 'Use the bridge link the user gave you.'), 404);
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (!allowedHost(req.headers.get('host'))) {
        return new Response('Wrong Host header: open the relay at http://localhost:' + port + '\n', { status: 421 });
      }
      if (url.pathname === '/healthz') return json({ ok: true, version: VERSION });
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(req, url);
      if (url.pathname.startsWith('/c/')) return browser(req, url);
      return new Response('baton relay. Open the link baton new printed.\n', {
        status: 404,
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    },
  });
  port = server.port ?? opts.port;
  return { server, port, store, stop: () => server.stop(true) };
}
