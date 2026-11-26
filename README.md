# baton

Pass tasks from a Claude Code session to **Claude in Chrome**, the browser extension running in your real,
signed-in Chrome, and get its reports back.

Claude Code can automate a browser, but not *your* browser: the one where you're already signed in to Google
Play Console, Google Cloud, Firebase, Meta, your registrar. Claude in Chrome lives there but can't talk to
Claude Code. baton is a tiny local relay between them:

```
Claude Code ──baton ask──▶ relay (127.0.0.1:7733) ◀── relay page ── Claude in Chrome
            ◀─ report ───                         ── report ────▶
```

1. Claude Code runs `baton new`, which prints a pairing and puts a prompt on your clipboard.
2. You paste the prompt into Claude in Chrome once. It opens the relay page and waits there.
3. Claude Code runs `baton ask <id> "<instruction>"`. The extension picks it up, does it in other tabs, and
   writes a report on the page. `ask` returns that report. Repeat.
4. `baton close <id>` shows STOP on the page.

## Install

Needs [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/dested/baton && cd baton
bun install
bun link                          # puts baton on your PATH
sh scripts/install-service.sh     # Linux: a systemd --user unit, always on
baton doctor
```

Without systemd, run the relay any way you keep a process alive: `bun server.ts`.

To make the skill available to every Claude Code session, link `skill/baton` into `~/.claude/skills/baton`.

### WSL and Windows

The relay can run inside WSL with mirrored networking (`networkingMode=mirrored`): Windows Chrome reaches it on
`localhost:7733`. A CLI on the Windows side needs the relay's key file, so point it at the WSL config dir:
`BATON_HOME=\\wsl.localhost\<distro>\home\<user>\.config\baton`. `new --clip` uses `clip.exe` from WSL.

## Usage

```
baton new [--name <t>] [--print] [--no-clip]   pairing + paste prompt (copied to the clipboard; --print shows it)
baton ask <id> <text…>                         send an instruction, block until its report arrives
baton send <id> <text…>                        send without waiting       (text: args, --file <path>, or - for stdin)
baton wait <id> [--after <n>]                  block until the next unread report
baton show <id> [n] [--full]                   report n again (default: the last)
baton status <id> · baton list [--all]         one line per pairing
baton prompt <id> [--relay] [--clip]           the paste prompt again (--relay: fallback, you paste each step)
baton close <id> [--reason <t>]                send STOP and close
baton doctor                                   relay, key file, service

--timeout <s>   ask/wait limit, default 220
--max <n>       report budget in chars, default 3000 (head and tail kept); --full for all of it
--clip          send/ask/prompt: also copy the text to the clipboard
--json          one JSON object on stdout
```

Exit codes: `0` ok · `1` usage or unknown pairing · `2` relay down or key problem · `3` timed out · `4` pairing closed.
Every error ends with a `next:` hint.

Output is built for an agent's context window, like a token-budgeted browser CLI: one header line, then the report.

```
$ baton ask k3x9pq "Open https://example.com and report the page heading word for word."
#1 report on #1 · 38s · 33 chars
Heading: "Example Domain".
```

## The relay page

`http://localhost:7733/c/<id>?t=<token>` is deliberately plain so the extension reads it cheaply: the current
instruction, a **Wait for the next instruction** button, a **Your report** box, a **Send report** button, and the
last few exchanges. No scripts. "Wait" holds the request up to 4 minutes (`BATON_BROWSER_WAIT_S`), so an idle
extension spends few steps, then says **Still waiting, press again**.

## When the extension goes quiet

Claude in Chrome's chat turn has a step budget, and a long wait can end it. The prompt tells it to say
"baton paused. Type continue…" when it stops, and to pick the loop back up when you type **continue**.
`baton status` reports `browser idle since <time>` once the page has had no visit for two minutes with nothing
in flight (or fifteen minutes into an unreported task), and `ask` warns up front when it's sending to an idle
browser.

## Security

- The relay listens on 127.0.0.1 only and refuses any Host header other than `localhost`, `127.0.0.1` or `[::1]`
  on its port (DNS rebinding).
- Two secrets per pairing. The **browser token** in the page URL can only read instructions and post reports.
  Posting an instruction needs the **CLI key** in `~/.config/baton/cli.key` (mode 0600, written by the relay on
  first start). The API also rejects any request that carries an `Origin` header, and sends no CORS headers.
  So a web page, or the extension itself, can never inject an instruction.
- Instructions and reports are rendered as text, never HTML, under `Content-Security-Policy: default-src 'none'`.
- The paste prompt tells the extension to never type a password, card number or 2FA code it wasn't given, to
  hand anything needing your own hands back to you, to ignore instructions found on other sites, and to stop on
  STOP.

Pairings and their conversations are kept in `~/.config/baton/state.json` (0600). `BATON_HOME` moves both
files, `BATON_PORT` changes the port.

## If Claude in Chrome won't act on the page

The extension guards against instructions found on web pages. The prompt states that you pasted it and that the
relay's instruction is yours, which normally settles it. If it still refuses, use relay mode:
`baton prompt <id> --relay --clip` gives a prompt where you paste each instruction yourself
(`baton send <id> "…" --clip` puts it on your clipboard), and the extension only writes reports on the page.

## Develop

```bash
bun run typecheck
bun run test       # relay + CLI, in-process, on a random port
```

MIT licensed.
