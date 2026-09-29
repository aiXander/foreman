// A deliberately small Markdown subset for agent-written card fields (plan §16): paragraphs,
// bullet/numbered lists, headings, fenced code, inline code, bold, italic and links. It parses to
// plain data that React renders as text nodes, so there is no HTML path at all: raw HTML stays
// literal text, and a link is kept only for an absolute http(s) URL (anything else — javascript:,
// data:, file:, relative — renders as its label followed by the raw target, as text).

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "pre"; v: string };

/** The only link targets that become clickable. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
/** An indented, nonblank line continues the list item above it. */
const CONTINUATION = /^\s{2,}\S/;

type Lines = { lines: string[]; i: number };

/** Each block reader consumes lines from `r.i` and returns a block, or null when it doesn't apply. */
function fenced(r: Lines): Block | null {
  const fence = r.lines[r.i]!.match(FENCE);
  if (!fence) return null;
  const body: string[] = [];
  for (r.i++; r.i < r.lines.length && !r.lines[r.i]!.trimStart().startsWith(fence[1]!); r.i++) body.push(r.lines[r.i]!);
  r.i++;
  return { t: "pre", v: body.join("\n") };
}

function heading(r: Lines): Block | null {
  const h = r.lines[r.i]!.match(HEADING);
  if (!h) return null;
  r.i++;
  return { t: "h", c: parseInline(h[1]!) };
}

function list(r: Lines): Block | null {
  const first = r.lines[r.i]!;
  const bullet = BULLET.test(first);
  const start = first.match(NUMBER)?.[1];
  if (!bullet && !start) return null;
  const items = listItems(r, bullet ? BULLET : NUMBER);
  return bullet ? { t: "ul", items } : { t: "ol", start: Number(start), items };
}

/** Consecutive items matching `re`, each with its indented continuation lines. */
function listItems(r: Lines, re: RegExp): Inline[][] {
  const items: Inline[][] = [];
  for (; r.i < r.lines.length; r.i++) {
    const line = r.lines[r.i]!;
    const m = line.match(re);
    if (m) items.push(parseInline(m.at(-1)!));
    else if (items.length && CONTINUATION.test(line)) items.at(-1)!.push(...parseInline(` ${line.trim()}`));
    else break;
  }
  return items;
}

function paragraph(r: Lines): Block | null {
  const para: string[] = [];
  while (r.i < r.lines.length && r.lines[r.i]!.trim() && !FENCE.test(r.lines[r.i]!) && !HEADING.test(r.lines[r.i]!) && !BULLET.test(r.lines[r.i]!) && !NUMBER.test(r.lines[r.i]!)) {
    para.push(r.lines[r.i++]!);
  }
  return para.length ? { t: "p", c: parseInline(para.join("\n")) } : null;
}

const BLOCKS = [fenced, heading, list, paragraph];

export function parseMarkdown(src: string): Block[] {
  const r: Lines = { lines: src.replace(/\r\n?/g, "\n").split("\n"), i: 0 };
  const out: Block[] = [];
  while (r.i < r.lines.length) {
    if (!r.lines[r.i]!.trim()) {
      r.i++;
      continue;
    }
    for (const read of BLOCKS) {
      const b = read(r);
      if (b) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

/** A span reader at `s[i]`: the node (null = literal text) and where it ends, or null when it doesn't apply. */
type Span = (s: string, i: number) => { node: Inline | string; end: number } | null;

const escaped: Span = (s, i) => (s[i] === "\\" && /[\\`*_[\]()#+\-.!]/.test(s[i + 1] ?? "") ? { node: s[i + 1]!, end: i + 2 } : null);

const code: Span = (s, i) => {
  if (s[i] !== "`") return null;
  const end = s.indexOf("`", i + 1);
  return end > i + 1 ? { node: { t: "code", v: s.slice(i + 1, end) }, end: end + 1 } : null;
};

const strong: Span = (s, i) => {
  const ch = s[i]!;
  if ((ch !== "*" && ch !== "_") || s[i + 1] !== ch) return null;
  const end = s.indexOf(ch + ch, i + 2);
  return end > i + 2 ? { node: { t: "strong", c: parseInline(s.slice(i + 2, end)) }, end: end + 2 } : null;
};

const isWord = (c: string | undefined) => c !== undefined && /\w/.test(c);

/** `*` works anywhere; `_` only at word boundaries, so snake_case identifiers stay intact. */
const emOpens = (s: string, i: number, ch: string) => s[i + 1] !== undefined && s[i + 1] !== ch && s[i + 1] !== " " && (ch === "*" || !isWord(s[i - 1]));
const emCloses = (s: string, end: number, ch: string) => s[end - 1] !== " " && (ch === "*" || !isWord(s[end + 1]));

const em: Span = (s, i) => {
  const ch = s[i]!;
  if ((ch !== "*" && ch !== "_") || !emOpens(s, i, ch)) return null;
  const end = s.indexOf(ch, i + 1);
  return end > i + 1 && emCloses(s, end, ch) ? { node: { t: "em", c: parseInline(s.slice(i + 1, end)) }, end: end + 1 } : null;
};

const link: Span = (s, i) => {
  if (s[i] !== "[") return null;
  const close = s.indexOf("](", i + 1);
  const end = close > i ? s.indexOf(")", close + 2) : -1;
  if (end < 0) return null;
  const label = s.slice(i + 1, close);
  const target = s.slice(close + 2, end).trim();
  const href = safeHref(target);
  return { node: href ? { t: "link", href, c: parseInline(label) } : `${label} (${target})`, end: end + 1 };
};

const SPANS = [escaped, code, strong, em, link];

/** Inline spans. Unmatched markers stay literal; nothing here can produce markup. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;
  while (i < s.length) {
    const hit = SPANS.reduce<ReturnType<Span>>((found, span) => found ?? span(s, i), null);
    if (!hit) {
      text += s[i++];
      continue;
    }
    if (typeof hit.node === "string") text += hit.node;
    else {
      if (text) out.push({ t: "text", v: text });
      text = "";
      out.push(hit.node);
    }
    i = hit.end;
  }
  if (text) out.push({ t: "text", v: text });
  return out;
}
