# Decisions

- **2026-11-25 · A standalone, generic tool.** It's a daemon plus a CLI with no tie to any one project, so it lives in its own public repo, not inside a project or a private toolbox.
- **2026-11-25 · Two secrets.** The browser token (in the page URL) can only read instructions and post reports; posting an instruction needs the CLI key from a 0600 file. The API refuses any request with an Origin header and any Host other than localhost/127.0.0.1/[::1] on the port, and sends no CORS headers. Neither a web page nor the extension itself can inject an instruction.
- **2026-11-25 · A page with no JavaScript and almost no styling.** Plain forms: the wait is a GET the server holds up to 50 s, the report a POST with a 303 back. A browser agent sees an ordinary page load; the page stays cheap to read or screenshot (last 6 exchanges, each clipped).
- **2026-11-25 · Token-budgeted CLI.** One header line per result, reports cut to 3000 chars (head 70 %, tail 30 %) with the command for the rest; `ask` blocks so a round trip is one call; default timeout 220 s keeps a call under an agent's prompt-cache window.
- **2026-11-25 · Authority comes from the paste.** The extension guards against instructions it reads on pages, so the prompt says the user pasted it and that the relay's instruction is theirs. Fallback when it still refuses: relay mode (`prompt --relay`, `send --clip`).
