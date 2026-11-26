import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The relay's port. BATON_PORT overrides it. */
export const DEFAULT_PORT = 7733;

export function batonPort(): number {
  const raw = process.env.BATON_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`BATON_PORT=${raw} is not a port number`);
  return n;
}

/** How long a "Wait for the next instruction" press is held open. BATON_BROWSER_WAIT_S overrides (max 240: Bun's idle timeout is 255 s). */
export function browserWaitMs(): number {
  const raw = process.env.BATON_BROWSER_WAIT_S;
  if (raw === undefined || raw === '') return 240_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`BATON_BROWSER_WAIT_S=${raw} is not a number of seconds`);
  return Math.min(n, 240) * 1000;
}

/**
 * The tool's own config dir: the CLI key and the pairings state, user-only (0700).
 * BATON_HOME overrides it, e.g. to point a Windows CLI at a relay running in WSL.
 */
export function batonHome(): string {
  const raw = process.env.BATON_HOME;
  if (raw !== undefined && raw !== '') return raw;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config'), 'baton');
}

export function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(home, 0o700);
}

export const keyPath = (home: string): string => join(home, 'cli.key');
export const statePath = (home: string): string => join(home, 'state.json');

/** The CLI key: created by the relay on first start, 0600, read by the CLI. Never printed. */
export function loadOrCreateKey(home: string): string {
  ensureHome(home);
  const p = keyPath(home);
  if (existsSync(p)) {
    const k = readFileSync(p, 'utf8').trim();
    if (k.length >= 32) return k;
  }
  const k = randomBytes(32).toString('base64url');
  writeFileSync(p, k + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(p, 0o600);
  return k;
}

export function readKey(home: string): string | null {
  const p = keyPath(home);
  if (!existsSync(p)) return null;
  const k = readFileSync(p, 'utf8').trim();
  return k.length > 0 ? k : null;
}
