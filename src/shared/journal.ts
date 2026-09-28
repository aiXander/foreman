// Append-only JSONL journal with one writer at a time (directory lock), per-journal monotonic
// seq, torn-final-line repair, request-id idempotency and fsync before acknowledging a durable
// write. All I/O is synchronous so a single process can never interleave two appends.
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, writeFileSync, ftruncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock } from "./lock";
import { ensureDir } from "./paths";

const MAX_LINE_BYTES = 64 * 1024;

export class JournalError extends Error {
  constructor(
    public code: "CORRUPT" | "LIMIT" | "CONFLICT" | "STORAGE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

export interface Draft {
  type: string;
  payload: unknown;
  /** Extra envelope fields (session, run, source...). */
  fields: Record<string, unknown>;
}

export interface Stored {
  v: number;
  id: string;
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
  request_id?: string;
  [k: string]: unknown;
}

export interface AppendOptions {
  lockTimeoutMs: number;
  /** fsync before returning; required for anything acknowledged to a caller. */
  durable: boolean;
  requestId?: string;
}

export interface AppendResult {
  events: Stored[];
  /** True when request_id matched an earlier identical append; nothing was written. */
  replayed: boolean;
}

export interface TransactOptions {
  lockTimeoutMs: number;
  durable: boolean;
  /**
   * Idempotency key plus a hash of the caller's *input*. A replay with the same hash returns the
   * original events without calling `decide` again (its output may depend on state that has moved
   * on, e.g. a revision number); a different hash is a CONFLICT.
   */
  request?: { id: string; hash: string };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function readTail(fd: number, size: number, want: number): Uint8Array {
  const len = Math.min(size, want);
  const buf = new Uint8Array(len);
  readSync(fd, buf, 0, len, size - len);
  return buf;
}

export class Journal {
  constructor(
    readonly file: string,
    readonly lockDir: string,
  ) {}

  /** Complete lines from `offset`. A trailing partial line is left for the next read. */
  readFrom(offset = 0): { events: Stored[]; nextOffset: number; corrupt: string | null } {
    if (!existsSync(this.file)) return { events: [], nextOffset: 0, corrupt: null };
    const fd = openSync(this.file, "r");
    try {
      const size = fstatSync(fd).size;
      if (offset >= size) return { events: [], nextOffset: offset, corrupt: null };
      const buf = new Uint8Array(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      const events: Stored[] = [];
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 10) continue;
        const line = dec.decode(buf.subarray(start, i));
        try {
          events.push(JSON.parse(line));
        } catch {
          return { events, nextOffset: offset + start, corrupt: `unparseable line at byte ${offset + start}` };
        }
        start = i + 1;
      }
      return { events, nextOffset: offset + start, corrupt: null };
    } finally {
      closeSync(fd);
    }
  }

  readAll(): Stored[] {
    const r = this.readFrom(0);
    if (r.corrupt) throw new JournalError("CORRUPT", `${this.file}: ${r.corrupt}`);
    return r.events;
  }

  append(drafts: Draft[], opts: AppendOptions): AppendResult {
    ensureDir(dirname(this.file));
    const lock = acquireLock(this.lockDir, opts.lockTimeoutMs);
    try {
      if (opts.requestId) {
        const prior = this.findRequest(opts.requestId);
        if (prior.length) {
          const same =
            prior.length === drafts.length &&
            prior.every((e, i) => e.type === drafts[i]!.type && JSON.stringify(e.payload) === JSON.stringify(drafts[i]!.payload));
          if (!same) throw new JournalError("CONFLICT", `request_id ${opts.requestId} was used with a different payload`);
          return { events: prior, replayed: true };
        }
      }
      return { events: this.write(drafts, opts.durable, opts.requestId ? { request_id: opts.requestId } : {}), replayed: false };
    } finally {
      lock.release();
    }
  }

  /**
   * Read-decide-append under the writer lock: `decide` sees every complete record and returns the
   * drafts to append (possibly none) plus a result. Nothing else can append in between, which is
   * what makes delivery claims and revision checks race-free across processes. `decide` must not
   * perform side effects outside the journal — the lock is held while it runs.
   */
  transact<R>(decide: (events: Stored[]) => { drafts: Draft[]; result: R }, opts: TransactOptions): { events: Stored[]; result: R | null; replayed: boolean } {
    ensureDir(dirname(this.file));
    const lock = acquireLock(this.lockDir, opts.lockTimeoutMs);
    try {
      const all = this.readAll();
      if (opts.request) {
        const prior = all.filter((e) => e.request_id === opts.request!.id);
        if (prior.length) {
          if (prior[0]!.request_hash !== opts.request.hash) throw new JournalError("CONFLICT", `request_id ${opts.request.id} was already used for a different call`);
          return { events: prior, result: null, replayed: true };
        }
      }
      const { drafts, result } = decide(all);
      const extra: Record<string, string> = opts.request ? { request_id: opts.request.id, request_hash: opts.request.hash } : {};
      const events = drafts.length ? this.write(drafts, opts.durable, extra) : [];
      return { events, result, replayed: false };
    } finally {
      lock.release();
    }
  }

  /** Caller holds the lock. */
  private write(drafts: Draft[], durable: boolean, extra: Record<string, string>): Stored[] {
    const fd = openSync(this.file, "a+", 0o600);
    try {
      let lastSeq = this.repairAndLastSeq(fd);
      const ts = new Date().toISOString();
      const events: Stored[] = drafts.map((d) => ({
        v: 1,
        id: crypto.randomUUID(),
        seq: ++lastSeq,
        ts,
        ...d.fields,
        type: d.type,
        payload: d.payload,
        ...extra,
      }));
      const lines = events.map((e) => {
        const bytes = enc.encode(JSON.stringify(e) + "\n");
        if (bytes.length > MAX_LINE_BYTES) throw new JournalError("LIMIT", `event exceeds ${MAX_LINE_BYTES} bytes`);
        return bytes;
      });
      const all = new Uint8Array(lines.reduce((n, l) => n + l.length, 0));
      let o = 0;
      for (const l of lines) {
        all.set(l, o);
        o += l.length;
      }
      try {
        writeSync(fd, all);
        if (durable) fsyncSync(fd);
      } catch (e: any) {
        throw new JournalError("STORAGE_UNAVAILABLE", `append failed: ${e?.message ?? e}`);
      }
      return events;
    } finally {
      closeSync(fd);
    }
  }

  private findRequest(requestId: string): Stored[] {
    return this.readAll().filter((e) => e.request_id === requestId);
  }

  /**
   * Under the lock: move an incomplete final line (a write that was never acknowledged) into a
   * diagnostic file and truncate it away, then return the last complete record's seq.
   * An unparseable complete final line is interior corruption: the journal becomes read-only.
   */
  private repairAndLastSeq(fd: number): number {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const tail = readTail(fd, size, 2 * MAX_LINE_BYTES + 2);
    let end = tail.length;
    if (tail[end - 1] !== 10) {
      const lastNl = tail.lastIndexOf(10);
      if (lastNl < 0 && tail.length < size) throw new JournalError("CORRUPT", `${this.file}: oversized torn tail`);
      const tornStart = lastNl + 1;
      writeFileSync(`${this.file}.torn-${Date.now()}`, tail.subarray(tornStart), { mode: 0o600 });
      const newSize = size - (tail.length - tornStart);
      ftruncateSync(fd, newSize);
      if (newSize === 0) return 0;
      end = tornStart;
    }
    const prevNl = tail.lastIndexOf(10, end - 2);
    if (prevNl < 0 && tail.length < size) {
      // Guard: MAX_LINE_BYTES bounds every line, so the window always holds one full line.
      throw new JournalError("CORRUPT", `${this.file}: final line exceeds limit`);
    }
    try {
      const last = JSON.parse(dec.decode(tail.subarray(prevNl + 1, end - 1)));
      if (!Number.isInteger(last.seq)) throw new Error("no seq");
      return last.seq;
    } catch {
      throw new JournalError("CORRUPT", `${this.file}: final record unparseable; journal is read-only`);
    }
  }
}
