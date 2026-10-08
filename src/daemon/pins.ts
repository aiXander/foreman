// Page pins (pages plan, item 5): one per mounted page file, outliving the session that mounted it.
// They live in `~/.foreman/ui/events.jsonl` next to the send trays. A pin binds to a session only
// through that session's own `page.set` journal event (an explicit foreman_page call), each applied
// exactly once by its event id, never by cwd or recency. The token is the page URL's capability.
// The pin also carries what the page may save itself (`writable`, P1b): the token authorizes those writes.
// The daemon fs-watches each pin's folder and reports changes so the host reloads the frame, except
// changes that are exactly the page's own last write (it already shows them).
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { PinView, SessionPage } from "../shared/api";
import { Journal, type Stored } from "../shared/journal";
import { ensureDir, paths } from "../shared/paths";
import { MAX_WRITABLE } from "../shared/protocol";
import type { JournalState } from "../shared/reducer";
import { LOCK_TIMEOUT } from "../shared/store";
import { etagOf } from "./page-server";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PinBound = z.strictObject({
  pin_id: z.uuid(),
  path: z.string().min(1).max(4096),
  title: z.string().min(1).max(80),
  token: z.string().regex(TOKEN_RE),
  session: z.uuid(),
  cwd: z.string().min(1).max(4096),
  /** The page.set event this binding applies. */
  event_id: z.uuid(),
  /** What the page may save itself (absent in P1 pins = nothing). */
  writable: z.array(z.string().min(1).max(512)).max(MAX_WRITABLE).optional(),
});
/** A session unmounted its page (`page.set` with path null): every pin bound to it is released. */
const PinUnbound = z.strictObject({ session: z.uuid(), event_id: z.uuid() });
/** The human removed a pin from the sidebar; the next mount of that file shows it again. */
const PinHidden = z.strictObject({ pin_id: z.uuid() });

export interface Pin {
  pin_id: string;
  path: string;
  title: string;
  token: string;
  session: string | null;
  cwd: string;
  writable: string[];
  bound_at: string;
  hidden: boolean;
}

interface Folded {
  byPath: Map<string, Pin>;
  applied: Set<string>;
}

const APPLY: Record<string, (f: Folded, payload: unknown, ts: string) => void> = {
  "pin.bound": (f, raw, ts) => {
    const p = PinBound.parse(raw);
    f.byPath.set(p.path, { pin_id: p.pin_id, path: p.path, title: p.title, token: p.token, session: p.session, cwd: p.cwd, writable: p.writable ?? [], bound_at: ts, hidden: false });
    f.applied.add(p.event_id);
  },
  "pin.unbound": (f, raw) => {
    const p = PinUnbound.parse(raw);
    for (const pin of f.byPath.values()) if (pin.session === p.session) pin.session = null;
    f.applied.add(p.event_id);
  },
  "pin.hidden": (f, raw) => {
    const p = PinHidden.parse(raw);
    for (const pin of f.byPath.values()) if (pin.pin_id === p.pin_id) pin.hidden = true;
  },
};

/** Pin events only; the trays' `tray.set` lines in the same file are skipped. */
function fold(events: Stored[]): Folded {
  const f: Folded = { byPath: new Map(), applied: new Set() };
  for (const e of events) APPLY[e.type]?.(f, e.payload, e.ts);
  return f;
}

/** Paths under a watched folder that never trigger a reload: dot segments (.git, editor swap files) and temp files. */
export function ignoredChange(name: string): boolean {
  const segs = name.split(/[\\/]/);
  return segs.some((s) => s.startsWith(".")) || /\.tmp$|~$/i.test(name);
}

const DEBOUNCE_MS = 150;

/**
 * The first prompt of an agent launched for a pin (Start agent, Fresh agent): mount the page again
 * with the same title and writable files, which rebinds the pin to the new session.
 */
export function startPrompt(pin: Pick<Pin, "path" | "title" | "writable">): string {
  const writable = pin.writable.length ? `, and writable ${JSON.stringify(pin.writable)}` : "";
  return `Show the page ${JSON.stringify(pin.path)} in Foreman: call foreman_page with that path, the title ${JSON.stringify(pin.title)}${writable}. Then wait for my messages from it.`;
}

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export class Pins {
  private journal = new Journal(paths.uiJournal(), paths.uiLock());
  private cache: { size: number; mtime: number; folded: Folded } | null = null;
  private watchers = new Map<string, FSWatcher>();
  /** Per watched folder: the debounce timer and the changed names it collected (null = unnamed event). */
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; names: Set<string | null> }>();
  /** Absolute path → ETag of the page's own last write there (the page-server records it). */
  private selfWrites = new Map<string, string>();
  private listeners = new Set<(pinId: string) => void>();

  constructor(readonly pageOrigin: string) {}

  private read(): Folded {
    ensureDir(paths.ui());
    const st = statSync(paths.uiJournal(), { throwIfNoEntry: false });
    const size = st?.size ?? 0;
    const mtime = st?.mtimeMs ?? 0;
    if (this.cache?.size === size && this.cache.mtime === mtime) return this.cache.folded;
    const folded = fold(this.journal.readAll());
    this.cache = { size, mtime, folded };
    return folded;
  }

  /**
   * Apply every session's latest page.set that no pin event has applied yet (oldest first). A mount
   * creates the file's pin or rebinds it to that session; an unmount releases the session's pins.
   */
  sync(states: JournalState[]): boolean {
    const { applied } = this.read();
    const pending = states.filter((s) => s.page_event && !applied.has(s.page_event.id)).sort((a, b) => a.page_event!.at.localeCompare(b.page_event!.at));
    if (!pending.length) return false;
    this.journal.transact(
      (events) => {
        const f = fold(events);
        const drafts = [];
        for (const s of pending) {
          const ev = s.page_event!;
          if (f.applied.has(ev.id)) continue;
          if (ev.path === null) {
            drafts.push({ type: "pin.unbound", payload: PinUnbound.parse({ session: s.session, event_id: ev.id }), fields: { source: "daemon" } });
            continue;
          }
          const prev = f.byPath.get(ev.path);
          const payload = PinBound.parse({
            pin_id: prev?.pin_id ?? crypto.randomUUID(),
            path: ev.path,
            title: ev.title ?? basename(ev.path),
            token: prev?.token ?? randomBytes(32).toString("base64url"),
            session: s.session,
            cwd: s.cwd,
            event_id: ev.id,
            writable: ev.writable,
          });
          drafts.push({ type: "pin.bound", payload, fields: { source: "daemon" } });
        }
        return { drafts, result: null };
      },
      { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true },
    );
    this.rewatch();
    return true;
  }

  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  hide(pinId: string): boolean {
    const tx = this.journal.transact(
      (events) => {
        const pin = [...fold(events).byPath.values()].find((p) => p.pin_id === pinId);
        if (!pin) return { drafts: [], result: false };
        if (pin.hidden) return { drafts: [], result: true };
        return { drafts: [{ type: "pin.hidden", payload: PinHidden.parse({ pin_id: pinId }), fields: { source: "daemon" } }], result: true };
      },
      { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true },
    );
    this.rewatch();
    return tx.result === true;
  }

  all(): Pin[] {
    return [...this.read().byPath.values()];
  }

  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  byId(pinId: string): Pin | null {
    return this.all().find((p) => p.pin_id === pinId) ?? null;
  }

  byToken(token: string): Pin | null {
    if (!TOKEN_RE.test(token)) return null;
    return this.all().find((p) => p.token === token) ?? null;
  }

  url(p: Pin): string {
    return `${this.pageOrigin}/p/${p.token}/${encodeURIComponent(basename(p.path))}`;
  }

  /** The sidebar's pins (hidden ones left out), by title. */
  views(): PinView[] {
    return this.all()
      .filter((p) => !p.hidden)
      .sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
      .map((p) => ({ pin_id: p.pin_id, path: p.path, title: p.title, url: this.url(p), session: p.session, cwd: p.cwd, writable: p.writable, bound_at: p.bound_at }));
  }

  /** `SessionView.page`: the session's mounted page with the pin that serves it. */
  sessionPage(s: JournalState): SessionPage | null {
    if (!s.page) return null;
    const pin = this.read().byPath.get(s.page.path);
    return pin ? { pin_id: pin.pin_id, path: pin.path, title: s.page.title, url: this.url(pin), writable: pin.writable } : null;
  }

  onPageChange(cb: (pinId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Watch the folder of every pin that is listed or still bound (recursive FSEvents on macOS). A
   * folder that can't be watched (deleted, unreadable) is retried on the next sync.
   */
  rewatch(): void {
    const want = new Set(this.all().filter((p) => !p.hidden || p.session).map((p) => dirname(p.path)));
    for (const [dir, w] of this.watchers) {
      if (want.has(dir)) continue;
      w.close();
      this.watchers.delete(dir);
    }
    for (const dir of want) if (!this.watchers.has(dir)) this.watch(dir);
  }

  private watch(dir: string): void {
    try {
      const w = watch(dir, { recursive: true }, (_ev, name) => {
        if (name && ignoredChange(name.toString())) return;
        this.changed(dir, name ? name.toString() : null);
      });
      w.on("error", () => {
        w.close();
        this.watchers.delete(dir);
      });
      this.watchers.set(dir, w);
    } catch {}
  }

  /**
   * The page at `path` just wrote these bytes itself (a successful PUT): when the watcher reports
   * that path with exactly this content, its frame isn't reloaded. Keyed by absolute path, so every
   * pin on that folder skips that one reload.
   */
  noteWrite(path: string, etag: string): void {
    this.selfWrites.set(path, etag);
  }

  private changed(dir: string, name: string | null): void {
    const prev = this.pending.get(dir);
    if (prev) clearTimeout(prev.timer);
    const names = prev?.names ?? new Set<string | null>();
    names.add(name);
    const timer = setTimeout(() => {
      this.pending.delete(dir);
      // A folder's own event (a file was added inside it) says nothing its files' events don't.
      if ([...names].every((n) => n !== null && (isDir(join(dir, n)) || this.isSelfWrite(join(dir, n))))) return;
      for (const pin of this.all()) if (dirname(pin.path) === dir) for (const cb of this.listeners) cb(pin.pin_id);
    }, DEBOUNCE_MS);
    this.pending.set(dir, { timer, names });
  }

  /** The file holds exactly what the page last wrote there. Anything else forgets that write. */
  private isSelfWrite(path: string): boolean {
    const want = this.selfWrites.get(path);
    if (!want) return false;
    let now: string | null = null;
    try {
      now = etagOf(readFileSync(path));
    } catch {}
    if (now === want) return true;
    this.selfWrites.delete(path);
    return false;
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
