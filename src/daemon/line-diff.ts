// A plain line diff for the page-edit text (pages plan, P2b): Myers' O(ND) over the lines left after
// trimming the common prefix and suffix, then unified-style hunks (1 line of context; the header names the place). Generic on purpose: no format
// knowledge beyond indentation, which names where a hunk sits (git's "function context").

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

export interface Hunk {
  /** `@@ -a,n +b,m @@ <where>` */
  header: string;
  lines: string[];
  added: number;
  removed: number;
}

const CONTEXT = 1;
/** Long lines are cut so the diff budget holds changes, not prose: context hardest. */
const CONTEXT_CHARS = 80;
const CHANGED_CHARS = 400;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Split text into lines; a final newline doesn't make an extra empty line. */
export const splitLines = (text: string) => (text === "" ? [] : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"));

/**
 * The shortest edit script from `a` to `b` (Myers), or null when the two differ by more than
 * `maxD` edits (a rewrite: not worth showing as a diff).
 */
// The textbook algorithm in one piece; splitting it would hide it.
// fallow-ignore-next-line complexity
function myers(a: string[], b: string[], maxD: number): Array<" " | "-" | "+"> | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] = v[-d-1 .. d+1] before step d (all that step d and its backtrack read).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Array<" " | "-" | "+"> {
  const out: Array<" " | "-" | "+"> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d]!;
    const at = (k: number) => t[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(prevK);
    const py = px - prevK;
    while (x > px && y > py) out.push(" "), x--, y--;
    if (d > 0) out.push(x === px ? "+" : "-");
    x = px;
    y = py;
  }
  return out.reverse();
}

/** Lengths of the common prefix and (non-overlapping) suffix. */
function commonEnds(a: string[], b: string[]): [number, number] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [pre, suf];
}

function editScript(a: string[], b: string[], maxD: number): Op[] | null {
  const [pre, suf] = commonEnds(a, b);
  const kinds = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxD);
  if (!kinds) return null;
  const all: Array<" " | "-" | "+"> = [...Array(pre).fill(" "), ...kinds, ...Array(suf).fill(" ")];
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const kind of all) {
    ops.push({ kind, line: kind === "+" ? b[j]! : a[i]!, a: i, b: j });
    if (kind !== "+") i++;
    if (kind !== "-") j++;
  }
  return ops;
}

const indent = (s: string) => s.length - s.trimStart().length;
const OPENER = /^(?:[[{(]|-)\s*$/;
const clean = (s: string) => {
  const t = s.trim().replace(/\s*:?\s*[[{(]?\s*,?\s*$/, "");
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};

/**
 * Where line `idx` sits, from indentation alone: the enclosing block heads, outermost first, at
 * most three, never the file's root. A head that only opens a block (`{`, `[`, `-`) is named by
 * the block's first line, so a JSON record shows as its first key (`"id": "voka"`).
 */
function where(lines: string[], idx: number, level: number): string {
  const labels: string[] = [];
  for (let j = headAbove(lines, idx, level); labels.length < 3 && j >= 0; j = headAbove(lines, j, indent(lines[j]!))) {
    const label = blockLabel(lines, j, idx);
    if (label.trim()) labels.unshift(clean(label));
  }
  return labels.join(" › ");
}

/** The nearest non-blank line above `i` indented less than `level`; -1 at the root (or none). */
function headAbove(lines: string[], i: number, level: number): number {
  let j = i - 1;
  while (j >= 0 && (!lines[j]!.trim() || indent(lines[j]!) >= level)) j--;
  return j >= 0 && indent(lines[j]!) > 0 ? j : -1;
}

/** A block head's name: the head itself, or for a bare opener the block's first line (unless that's the changed line). */
function blockLabel(lines: string[], j: number, idx: number): string {
  const head = lines[j]!;
  if (!OPENER.test(head.trim())) return head;
  const first = lines[j + 1];
  return j + 1 !== idx && first && indent(first) > indent(head) ? first : "";
}

/**
 * Unified hunks from `before` to `after` (1 line of context), or null when they differ by more
 * than `maxD` line edits. Empty when the texts are equal.
 */
export function lineHunks(before: string, after: string, maxD = 1000): Hunk[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = editScript(a, b, maxD);
  if (!ops) return null;
  const changed = ops.flatMap((o, i) => (o.kind === " " ? [] : [i]));
  const hunks: Hunk[] = [];
  for (let g = 0; g < changed.length; ) {
    let last = g;
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! - 1 <= 2 * CONTEXT) last++;
    const first = changed[g]!;
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, changed[last]! + CONTEXT);
    const span = ops.slice(from, to + 1);
    const oldLen = span.filter((o) => o.kind !== "+").length;
    const newLen = span.filter((o) => o.kind !== "-").length;
    const start = ops[from]!;
    const fc = ops[first]!;
    const loc = fc.kind === "+" ? where(b, fc.b, indent(fc.line)) : where(a, fc.a, indent(fc.line));
    hunks.push({
      header: `@@ -${start.a + (oldLen ? 1 : 0)},${oldLen} +${start.b + (newLen ? 1 : 0)},${newLen} @@${loc ? ` ${loc}` : ""}`,
      lines: span.map((o) => `${o.kind}${clip(o.line, o.kind === " " ? CONTEXT_CHARS : CHANGED_CHARS)}`),
      added: span.filter((o) => o.kind === "+").length,
      removed: span.filter((o) => o.kind === "-").length,
    });
    g = last + 1;
  }
  return hunks;
}
