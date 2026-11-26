# baton — CliffNotes

> Living map. Last updated: 2026-11-25. README.md is the user-facing doc; this is the map for whoever changes the code.

## Quick reference

- **Port:** 7733 (`http://localhost:7733`), `BATON_PORT` overrides. 127.0.0.1 only.
- **Relay:** `bun server.ts`; as a systemd user unit `baton` via `sh scripts/install-service.sh` (`--uninstall`). No --watch: restart the unit after a server change (`systemctl --user restart baton`).
- **CLI:** `baton` (package.json bin, `bun link`). `baton --help`.
- **Skill:** `skill/baton/SKILL.md`, linked into `~/.claude/skills/baton` by the machine's own setup.
- **State:** `$BATON_HOME` or `$XDG_CONFIG_HOME/baton` or `~/.config/baton` (0700): `cli.key` (0600, written by the relay on first start), `state.json` (0600, every pairing).
- **Checks:** `bun run typecheck`, `bun run test` (in-process relay + CLI spawns), `baton doctor`.

## Files

```
server.ts                   entry: startServer on batonPort(), batonHome()
src/server.ts               Bun.serve: /healthz, /api/* (CLI: Bearer key, refuses any Origin), /c/<id>[/wait|/report] (browser: token)
src/store.ts                pairings + long-poll waiters, persisted to state.json after every change
src/page.ts                 the page: escaped text, no scripts, last 6 exchanges clipped to 300 chars
src/prompt.ts               the paste prompt and the relay-mode fallback prompt
src/schema.ts               zod: state file and every API answer (the CLI parses them all)
src/config.ts               port, config dir, key file
cli/baton.ts                the CLI: one-line output, report budget (head+tail, --full), --json, exit codes
scripts/install-service.sh  the systemd user unit
skill/baton/SKILL.md        the Claude Code skill
test/relay.test.ts          relay + CLI tests
```

## Protocol

- Browser: `GET /c/<id>?t=<token>` renders. "Wait for the next instruction" is `GET /c/<id>/wait?t=&after=<seq>`, held up to 240 s (BATON_BROWSER_WAIT_S; Bun's idleTimeout is 255), then the page with "New instruction #n" or "Still waiting, press again". "Send report" posts `/c/<id>/report` (urlencoded t, about, report) and 303s back with `sent=<n>`.
- CLI: `POST /api/pairings`, `GET /api/pairings[/<id>[/prompt|/report[/<n>]]]`, `POST /api/pairings/<id>/send`, `GET /api/pairings/<id>/wait?after=&timeout=` (≤90 s per request; the CLI loops to its own --timeout), `POST /api/pairings/<id>/close` (posts a STOP instruction, then closes).
- Browser activity: `browserActiveAt` (page load, wait press, wait return, report) and `waitsSinceReport` are persisted; the view derives `browserState` new/waiting/active/idle (idle after 120 s quiet, 900 s while an instruction is picked up but unreported). Both fields default for older state files.
- `ask` waits for a report newer than the report count at send time; plain `wait` reads from the CLI cursor (last report handed out).
- Mirrored loopback (WSL): a connect to a closed port can hang instead of being refused, so the CLI probes `/healthz` with a 2.5 s timeout before anything else.
