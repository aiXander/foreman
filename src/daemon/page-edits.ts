// The page-edit diff (pages plan, P2b; D22): the agent sees the human's direct edits on its next
// batch instead of a turn per click. The store records what each successful page PUT changed (the
// bytes before and after), so the diff is exactly the page's changes and never the agent's own
// edits. Consecutive saves of a file chain into one segment (before of the first, after of the
// last); a save on top of bytes someone else wrote starts a new segment, so an agent edit in
// between stays out. A batch created for the bound session takes the pending edits as a preface
// frozen into its text, and only once it is durable are they cleared. One JSON file per pin under
// `ui/page-edits/`, so a daemon restart doesn't drop them. A pin rebound to another session (Fresh
// agent, Start agent) starts empty: a new agent reads the files itself.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../shared/paths";
import { lineHunks, splitLines, type Hunk } from "./line-diff";
import { etagOf } from "./page-server";
import type { Pin } from "./pins";

/** The diff text's budget (bytes of hunks); past it, per-file summary lines. */
const EDIT_DIFF_BUDGET = 2048;
const MAX_SEGMENTS = 20;

interface Segment {
  /** The file before the first save of this run of saves; null = the page created it. */
  before: string | null;
  /** After the last save (null for a created file: only its size is shown). */
  after: string | null;
  etag: string;
  bytes: number;
}

interface PinEdits {
  session: string;
  /** Bumped per recorded save, so a batch clears only what it showed. */
  rev: number;
  files: Record<string, Segment[]>;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export class PageEdits {
  constructor(private pins: { all(): Pin[] }) {}

  private load(pinId: string): PinEdits | null {
    try {
      return JSON.parse(readFileSync(paths.pageEdits(pinId), "utf8")) as PinEdits;
    } catch {
      return null;
    }
  }

  private save(pinId: string, e: PinEdits): void {
    const file = paths.pageEdits(pinId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** A page save just committed: `old` (null = created) became `next`. Nothing without a bound agent. */
  record(pin: Pin, rel: string, old: Uint8Array | null, next: Uint8Array): void {
    if (!pin.session) return;
    try {
      const prev = this.load(pin.pin_id);
      const e: PinEdits = prev?.session === pin.session ? prev : { session: pin.session, rev: 0, files: {} };
      addSave((e.files[rel] ??= []), old, next);
      e.rev++;
      this.save(pin.pin_id, e);
    } catch (err) {
      console.error(`page edits ${pin.pin_id}: ${(err as Error).message}`); // the write itself already succeeded
    }
  }

  /**
   * The pending edits of every page bound to `session`, rendered for a batch (`text` null when
   * nothing changed in effect), and `done` to call once that batch is durable. A save that lands
   * after this call is kept for the next batch.
   */
  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  take(session: string): { text: string | null; done: () => void } {
    const shown: Array<[string, number]> = [];
    const files: Array<[string, Segment[]]> = [];
    for (const pin of this.pins.all()) {
      if (pin.session !== session) continue;
      const e = this.load(pin.pin_id);
      if (e?.session !== session) continue;
      shown.push([pin.pin_id, e.rev]);
      files.push(...Object.entries(e.files));
    }
    const done = () => {
      for (const [pinId, rev] of shown) if (this.load(pinId)?.rev === rev) rmSync(paths.pageEdits(pinId), { force: true });
    };
    return { text: files.length ? renderEdits(files) : null, done };
  }
}

/** Extend the last segment when this save starts from exactly its result; otherwise start a new one. */
function addSave(segs: Segment[], old: Uint8Array | null, next: Uint8Array): void {
  const last = segs.at(-1);
  const etag = etagOf(next);
  if (last && old && last.etag === etagOf(old)) {
    if (last.before !== null) last.after = text(next);
    Object.assign(last, { etag, bytes: next.byteLength });
    return;
  }
  segs.push({ before: old ? text(old) : null, after: old ? text(next) : null, etag, bytes: next.byteLength });
  if (segs.length > MAX_SEGMENTS) segs.splice(0, segs.length - MAX_SEGMENTS);
}

/** A file's hunks over all its segments, and what was too different to diff. */
function fileHunks(segs: Segment[]): { hunks: Hunk[]; rewritten: string | null } {
  const hunks: Hunk[] = [];
  let rewritten: string | null = null;
  for (const s of segs) {
    const h = lineHunks(s.before!, s.after!);
    if (h) hunks.push(...h);
    else rewritten = `${splitLines(s.before!).length} → ${splitLines(s.after!).length} lines`;
  }
  return { hunks, rewritten };
}

/** One changed file's lines: the hunks that still fit `budget.left` (in order), then a summary of the rest. */
function fileLines(rel: string, segs: Segment[], budget: { left: number }): string[] {
  const { hunks, rewritten } = fileHunks(segs);
  const shown: string[] = [];
  const rest = { n: 0, plus: 0, minus: 0 };
  for (const h of hunks) {
    const block = [h.header, ...h.lines].join("\n");
    const size = Buffer.byteLength(block) + 1;
    if (rest.n === 0 && size <= budget.left) {
      shown.push(block);
      budget.left -= size;
    } else {
      rest.n++;
      rest.plus += h.added;
      rest.minus += h.removed;
    }
  }
  const out = shown.length ? [`${rel}:`, "```diff", ...shown, "```"] : [];
  const more = shown.length ? "more " : "";
  if (rest.n) out.push(`${rel}: ${rest.n} ${more}change${rest.n === 1 ? "" : "s"} not shown (+${rest.plus} −${rest.minus} lines); read the file, or \`git diff ${rel}\` if the folder is in git`);
  if (rewritten) out.push(`${rel}: rewritten (${rewritten}), too different to diff; read the file`);
  return out;
}

/**
 * The batch preface: hunks per file within EDIT_DIFF_BUDGET bytes, then one summary line per file
 * for whatever didn't fit. A created file is its name and size. Null when nothing changed in effect.
 */
export function renderEdits(files: Array<[string, Segment[]]>, budget = EDIT_DIFF_BUDGET): string | null {
  const left = { left: budget };
  const out = files.flatMap(([rel, segs]) => (segs.some((s) => s.before === null) ? [`${rel}: new file (${kb(segs.at(-1)!.bytes)}), not shown`] : fileLines(rel, segs, left)));
  if (!out.length) return null;
  // Many dropped files could still grow it: keep the whole preface well inside the batch limit.
  while (Buffer.byteLength(out.join("\n")) > EDIT_DIFF_BUDGET * 3) out.splice(-2, 2, "(more page edits not shown; read the files)");
  return ["Since your last Foreman message the human edited these files directly in the page (already saved; their truth, take it as context):", ...out].join("\n");
}
