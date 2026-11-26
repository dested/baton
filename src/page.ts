import type { Message, Pairing } from './schema.ts';
import { lastSeq } from './store.ts';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Just enough for big, legible text in a screenshot. No colors, no layout. */
const STYLE = 'body{font:20px/1.5 system-ui,sans-serif;max-width:52em;margin:1em auto;padding:0 1em}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}textarea{width:100%;font:inherit}button{font:inherit;font-weight:bold;padding:.4em 1em}';

/** The page shows the last few exchanges, each clipped, so a page read stays cheap as a pairing grows. */
const LOG_ENTRIES = 6;
const LOG_CHARS = 300;

export type PageNotice = string;

export function pairingPage(p: Pairing, notice: PageNotice | null): string {
  const current = [...p.messages].reverse().find((m) => m.kind === 'instruction');
  const closed = p.closedAt !== null;
  const t = esc(p.token);
  const top = closed ? 'This bridge is closed. Stop all work now and tell the user in the chat that you stopped.' : notice;

  const instruction = current
    ? `<h2>Current instruction (#${current.seq})</h2>\n<pre id="instruction">${esc(current.text)}</pre>`
    : '<h2>Current instruction</h2>\n<p id="instruction">None yet. Press "Wait for the next instruction".</p>';

  const controls = closed
    ? ''
    : `<form method="get" action="/c/${esc(p.id)}/wait"><input type="hidden" name="t" value="${t}"><input type="hidden" name="after" value="${lastSeq(p, 'instruction')}"><p><button type="submit">Wait for the next instruction</button></p></form>
<form method="post" action="/c/${esc(p.id)}/report"><input type="hidden" name="t" value="${t}"><input type="hidden" name="about" value="${current?.seq ?? 0}">
<h2><label for="report">Your report</label></h2>
<textarea id="report" name="report" rows="8" required></textarea>
<p><button type="submit">Send report</button></p></form>`;

  const shown = p.messages.slice(-LOG_ENTRIES);
  const hidden = p.messages.length - shown.length;
  const log = p.messages.length
    ? `${hidden > 0 ? `<p>(${hidden} earlier)</p>` : ''}<ul>${shown.map(logItem).join('')}</ul>`
    : '<p>Nothing yet.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>baton: ${esc(p.name)}</title><style>${STYLE}</style></head>
<body>
<h1>baton: ${esc(p.name)}</h1>
${top ? `<p id="notice"><strong>${esc(top)}</strong></p>` : ''}
${instruction}
${controls}
<h2>Conversation so far</h2>
${log}
</body></html>`;
}

function logItem(m: Message): string {
  const head = m.kind === 'instruction' ? `Instruction #${m.seq}` : `Report #${m.seq}${m.about ? ` (on #${m.about})` : ''}`;
  const text = m.text.length > LOG_CHARS ? m.text.slice(0, LOG_CHARS) + ' …' : m.text;
  return `<li><strong>${head}:</strong> <pre>${esc(text)}</pre></li>`;
}

export function messagePage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><h1>${esc(title)}</h1><p id="notice"><strong>${esc(body)}</strong></p></body></html>`;
}
