import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKey } from '../src/config.ts';
import { startServer } from '../src/server.ts';

const home = mkdtempSync(join(tmpdir(), 'baton-test-'));
let relay: ReturnType<typeof startServer>;
let base = '';
let key = '';

beforeAll(() => {
  relay = startServer({ port: 0, home, browserWaitMs: 1200, cliWaitCapMs: 5000 });
  base = `http://127.0.0.1:${relay.port}`;
  key = readKey(home) ?? '';
});
afterAll(() => {
  relay.stop();
  rmSync(home, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(base + path, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers } });

async function newPairing(name = 'test'): Promise<{ id: string; url: string; token: string }> {
  const r = await api('/api/pairings', { method: 'POST', body: JSON.stringify({ name }) });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { pairing: { id: string }; url: string };
  const token = new URL(body.url).searchParams.get('t') ?? '';
  return { id: body.pairing.id, url: body.url, token };
}

const page = (id: string, token: string, suffix = ''): Promise<Response> => fetch(`${base}/c/${id}${suffix}${suffix.includes('?') ? '&' : '?'}t=${token}`);

const report = (id: string, token: string, text: string, about: number): Promise<Response> =>
  fetch(`${base}/c/${id}/report`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: token, report: text, about: String(about) }),
  });

describe('relay', () => {
  test('key file is user-only', () => {
    expect(statSync(join(home, 'cli.key')).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test('API refuses a missing key, a wrong key, and any browser Origin', async () => {
    expect((await fetch(base + '/api/pairings')).status).toBe(401);
    expect((await fetch(base + '/api/pairings', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await api('/api/pairings', { headers: { Origin: 'http://localhost:1234' } })).status).toBe(403);
  });

  test('no CORS headers, strict CSP on pages', async () => {
    const p = await newPairing();
    const r = await page(p.id, p.token);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    const a = await api('/api/pairings');
    expect(a.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('wrong or missing token gets the 403 page, not the conversation', async () => {
    const p = await newPairing();
    await api(`/api/pairings/${p.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'secret instruction' }) });
    for (const t of ['', 'wrong', p.token.slice(0, -1)]) {
      const r = await page(p.id, t);
      expect(r.status).toBe(403);
      const body = await r.text();
      expect(body).toContain('Wrong bridge link');
      expect(body).not.toContain('secret instruction');
    }
    const bad = await report(p.id, 'wrong', 'injected', 1);
    expect(bad.status).toBe(403);
    const s = (await (await api(`/api/pairings/${p.id}`)).json()) as { pairing: { reports: number } };
    expect(s.pairing.reports).toBe(0);
  });

  test('instructions and reports render as text, never HTML', async () => {
    const p = await newPairing('<b>name</b>');
    await api(`/api/pairings/${p.id}/send`, { method: 'POST', body: JSON.stringify({ text: '<script>alert(1)</script> & <img src=x>' }) });
    await report(p.id, p.token, '<iframe src="http://evil"></iframe>', 1);
    const body = await (await page(p.id, p.token)).text();
    expect(body).not.toContain('<script>alert');
    expect(body).not.toContain('<img src=x>');
    expect(body).not.toContain('<iframe');
    expect(body).not.toContain('<b>name</b>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x&gt;');
    expect(body).toContain('Current instruction (#1)');
  });

  test('a Host header other than localhost is refused (DNS rebinding)', async () => {
    const r = await fetch(base + '/healthz', { headers: { Host: 'evil.example:80' } });
    expect(r.status).toBe(421);
  });

  test('browser wait times out with "Still waiting, press again"', async () => {
    const p = await newPairing();
    const t0 = Date.now();
    const r = await page(p.id, p.token, '/wait?after=0');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1100);
    expect(await r.text()).toContain('Still waiting, press again');
  });

  test('full loop: send, browser wait wakes, report, CLI wait returns it', async () => {
    const p = await newPairing();
    const waiting = page(p.id, p.token, '/wait?after=0');
    await Bun.sleep(150);
    const st = (await (await api(`/api/pairings/${p.id}`)).json()) as { pairing: { browserWaiting: boolean } };
    expect(st.pairing.browserWaiting).toBe(true);
    await api(`/api/pairings/${p.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'open example.com' }) });
    const html = await (await waiting).text();
    expect(html).toContain('open example.com');
    expect(html).toContain('New instruction #1');

    const cliWait = api(`/api/pairings/${p.id}/wait?timeout=5`);
    const posted = await report(p.id, p.token, 'Title was Example Domain', 1);
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toContain('sent=1');
    const w = (await (await cliWait).json()) as { status: string; report: { text: string; about: number } };
    expect(w.status).toBe('report');
    expect(w.report.text).toBe('Title was Example Domain');
    expect(w.report.about).toBe(1);

    const again = (await (await api(`/api/pairings/${p.id}/wait?timeout=1`)).json()) as { status: string };
    expect(again.status).toBe('timeout');
  });

  test('close sends STOP, the page says closed, sends are refused', async () => {
    const p = await newPairing();
    const waiting = page(p.id, p.token, '/wait?after=0');
    await Bun.sleep(100);
    expect((await api(`/api/pairings/${p.id}/close`, { method: 'POST', body: '{}' })).status).toBe(200);
    const html = await (await waiting).text();
    expect(html).toContain('This bridge is closed');
    expect(html).toContain('STOP');
    expect(html).not.toContain('Send report');
    expect((await api(`/api/pairings/${p.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status).toBe(409);
    const w = (await (await api(`/api/pairings/${p.id}/wait?timeout=1`)).json()) as { status: string };
    expect(w.status).toBe('closed');
  });

  test('pairings survive a relay restart', async () => {
    const p = await newPairing('persist');
    relay.stop();
    relay = startServer({ port: relay.port, home, browserWaitMs: 1200, cliWaitCapMs: 5000 });
    const r = await page(p.id, p.token);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('baton: persist');
  });
});

describe('cli', () => {
  // async spawn: the relay runs in this process, so a sync spawn would block it
  const cli = async (args: string[], port: number) => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'cli', 'baton.ts'), ...args], {
      env: { ...process.env, BATON_HOME: home, BATON_PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };

  test('new, send, wait timeout (exit 3), report, wait (exit 0), show, status, close', { timeout: 20000 }, async () => {
    const n = await cli(['new', '--name', 'cli test', '--no-clip', '--json'], relay.port);
    expect(n.exitCode).toBe(0);
    const made = JSON.parse(n.stdout) as { id: string; url: string; prompt: string; clipboard: boolean };
    expect(made.prompt).toContain(made.url);
    expect(made.clipboard).toBe(false);
    const { id } = made;
    const token = new URL(made.url).searchParams.get('t') ?? '';

    const sent = await cli(['send', id, 'do', 'the', 'thing'], relay.port);
    expect(sent.exitCode).toBe(0);
    expect(sent.stdout.trim()).toBe(`sent #1 → ${id}`);
    const t = await cli(['wait', id, '--timeout', '1'], relay.port);
    expect(t.exitCode).toBe(3);
    expect(t.stdout.trim().split('\n')).toHaveLength(1);
    expect(t.stdout).toContain('timeout 1s');

    await report(id, token, 'done: value 42', 1);
    const w = await cli(['wait', id, '--timeout', '5'], relay.port);
    expect(w.exitCode).toBe(0);
    expect(w.stdout).toMatch(/^#1 report on #1 · \d+s · 14 chars\ndone: value 42\n$/);

    expect((await cli(['send', id, 'long'], relay.port)).exitCode).toBe(0);
    await report(id, token, 'A'.repeat(5000) + 'END', 2);
    const long = await cli(['wait', id, '--max', '100'], relay.port);
    expect(long.stdout).toContain(`[4903 chars cut: baton show ${id} 2 --full]`);
    expect(long.stdout).toContain('END');
    const full = await cli(['show', id, '2', '--full', '--json'], relay.port);
    const fj = JSON.parse(full.stdout) as { text: string; trimmed: number };
    expect(fj.text.length).toBe(5003);
    expect(fj.trimmed).toBe(0);

    const s = await cli(['status', id], relay.port);
    expect(s.stdout).toContain('2 reports (0 unread)');
    expect(s.stdout.trim().split('\n')).toHaveLength(1);
    expect((await cli(['close', id], relay.port)).exitCode).toBe(0);
    expect((await cli(['send', id, 'more'], relay.port)).exitCode).toBe(4);
  });

  test('ask blocks until the report that follows it', { timeout: 20000 }, async () => {
    const n = JSON.parse((await cli(['new', '--no-clip', '--json'], relay.port)).stdout) as { id: string; url: string };
    const token = new URL(n.url).searchParams.get('t') ?? '';
    const asking = cli(['ask', n.id, 'what is 6*7', '--timeout', '10'], relay.port);
    await Bun.sleep(1500);
    await report(n.id, token, '42', 1);
    const a = await asking;
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toMatch(/^#1 report on #1 · \d+s · 2 chars\n42\n$/);
  });

  test('unknown pairing is exit 1, relay down is exit 2, both say what to do next', { timeout: 20000 }, async () => {
    const u = await cli(['status', 'nope00'], relay.port);
    expect(u.exitCode).toBe(1);
    expect(u.stderr).toContain('next: Run baton list');
    const d = await cli(['list'], 1);
    expect(d.exitCode).toBe(2);
    expect(d.stderr).toContain('next: start the relay');
  });
});
