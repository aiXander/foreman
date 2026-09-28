// Disposable SQLite projection of the session journals. The journals are the truth: deleting
// cache/projection.sqlite only costs a replay. Each session's fold state is stored with the byte
// offset it covers so restarts resume tailing instead of refolding everything.
import { Database } from "bun:sqlite";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { parseEvent } from "../shared/events";
import { Journal } from "../shared/journal";
import { ensureHome, paths } from "../shared/paths";
import { foldJournal, reduce, type JournalState } from "../shared/reducer";
import { listSessionIds, sessionJournal } from "../shared/store";

const SCHEMA_VERSION = "4";
const POLL_MS = 1000;

interface Row {
  session: string;
  offset: number;
  state: JournalState | null;
  corrupt: string | null;
  /** File size when last read; lets a corrupt (read-only) journal be skipped until it changes. */
  seen?: number;
}

export class Projection {
  private db: Database;
  private rows = new Map<string, Row>();
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(session: string, state: JournalState | null, corrupt: string | null) => void>();
  private pending = new Set<string>();
  private flushScheduled = false;

  constructor(file = paths.projection()) {
    ensureHome();
    this.db = new Database(file, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const v = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get();
    if (v?.value !== SCHEMA_VERSION) {
      this.db.run("DROP TABLE IF EXISTS journals");
      this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", [SCHEMA_VERSION]);
    }
    this.db.run("CREATE TABLE IF NOT EXISTS journals (session TEXT PRIMARY KEY, offset INTEGER NOT NULL, state TEXT, corrupt TEXT)");
    for (const r of this.db.query<{ session: string; offset: number; state: string | null; corrupt: string | null }, []>("SELECT * FROM journals").all()) {
      this.rows.set(r.session, { session: r.session, offset: r.offset, state: r.state ? JSON.parse(r.state) : null, corrupt: r.corrupt });
    }
  }

  onChange(cb: (session: string, state: JournalState | null, corrupt: string | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  states(): JournalState[] {
    return [...this.rows.values()].flatMap((r) => (r.state ? [r.state] : []));
  }

  get(session: string): JournalState | null {
    return this.rows.get(session)?.state ?? null;
  }


  /** Catch up every journal, then watch (FSEvents) with a polling safety net. */
  start(): void {
    for (const id of listSessionIds()) this.refresh(id);
    for (const id of [...this.rows.keys()]) if (!existsSync(paths.sessionJournal(id))) this.drop(id);
    try {
      this.watcher = watch(paths.sessions(), { recursive: true }, (_ev, name) => {
        const id = name?.toString().split(/[\\/]/)[0];
        if (id && /^[0-9a-f-]{36}$/.test(id)) this.schedule(id);
      });
    } catch {
      this.watcher = null; // polling covers it
    }
    this.timer = setInterval(() => {
      for (const id of listSessionIds()) {
        const size = fileSize(paths.sessionJournal(id));
        const row = this.rows.get(id);
        if (!row || (size !== row.offset && size !== row.seen)) this.schedule(id);
      }
    }, POLL_MS);
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    this.db.close();
  }

  private schedule(id: string): void {
    this.pending.add(id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const ids = [...this.pending];
      this.pending.clear();
      for (const s of ids) this.refresh(s);
    }, 15);
  }

  /** Fold new complete lines for one session. A shrunken journal is refolded from zero. */
  refresh(id: string): void {
    const file = paths.sessionJournal(id);
    const size = fileSize(file);
    let row = this.rows.get(id);
    if (size < 0) return;
    if (row?.corrupt && size === row.seen) return;
    if (!row || size < row.offset || row.corrupt) {
      row = { session: id, offset: 0, state: null, corrupt: null };
    }
    if (size === row.offset && this.rows.get(id) === row) return;
    const j: Journal = sessionJournal(id);
    const r = j.readFrom(row.offset);
    // Replay validates every record: an event from an incompatible version (or one whose payload
    // no longer matches its schema) stops the fold visibly instead of being skipped.
    for (let i = 0; i < r.events.length; i++) {
      try {
        parseEvent(r.events[i]);
      } catch (e) {
        r.corrupt = `event seq ${r.events[i]!.seq ?? "?"} failed validation: ${(e as Error).message.slice(0, 200)}`;
        r.events = r.events.slice(0, i);
        break;
      }
    }
    if (r.corrupt && r.corrupt !== row.corrupt) console.error(`journal ${id} is read-only for the projection: ${r.corrupt}`);
    let state = row.offset === 0 ? foldJournal(r.events) : row.state;
    if (row.offset !== 0) for (const e of r.events) state = reduce(state, e);
    const next: Row = { session: id, offset: r.nextOffset, state, corrupt: r.corrupt, seen: size };
    this.rows.set(id, next);
    this.db.run("INSERT OR REPLACE INTO journals (session, offset, state, corrupt) VALUES (?, ?, ?, ?)", [
      id,
      next.offset,
      state ? JSON.stringify(state) : null,
      next.corrupt,
    ]);
    if (r.events.length || r.corrupt) for (const cb of this.listeners) cb(id, state, next.corrupt);
  }

  private drop(id: string): void {
    this.rows.delete(id);
    this.db.run("DELETE FROM journals WHERE session = ?", [id]);
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}
