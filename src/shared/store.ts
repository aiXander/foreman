// Session storage helpers shared by hooks, CLI, MCP (later) and the daemon: the journal for a
// session, validated appends, the rebuildable manifest cache and the native-id identity map.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { validatePayload, type EventType, type Payload, type Source } from "./events";
import { Journal, type AppendResult } from "./journal";
import { ensureDir, paths } from "./paths";

export const LOCK_TIMEOUT = {
  /** Passive telemetry: give up fast, log/drop, never stall Claude. */
  passive: 250,
  /** Explicit mutations: longer wait, then a retryable error to the caller. */
  mutation: 2000,
} as const;

export function sessionJournal(session: string): Journal {
  return new Journal(paths.sessionJournal(session), paths.sessionLock(session));
}

export interface EventInput<T extends EventType = EventType> {
  type: T;
  payload: Payload<T>;
}

export function appendSessionEvents(
  session: string,
  run: string | null,
  source: Source,
  inputs: EventInput[],
  opts: { passive?: boolean; requestId?: string } = {},
): AppendResult {
  ensureDir(paths.session(session));
  const drafts = inputs.map((i) => ({
    type: i.type,
    payload: validatePayload(i.type, i.payload),
    fields: { session, run, source },
  }));
  return sessionJournal(session).append(drafts, {
    lockTimeoutMs: opts.passive ? LOCK_TIMEOUT.passive : LOCK_TIMEOUT.mutation,
    durable: !opts.passive,
    requestId: opts.requestId,
  });
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Rebuildable latest-identity cache for one session. Never authoritative over the journal. */
export interface Manifest {
  session: string;
  vendor: "claude";
  native_id: string;
  project: string;
  cwd: string;
  run: string | null;
  target: string | null;
  mode: "managed" | "observed";
  terminal_id: string | null;
  updated_at: string;
}

export function readManifest(session: string): Manifest | null {
  return readJson<Manifest>(paths.sessionManifest(session));
}

export function writeManifest(m: Manifest): void {
  ensureDir(paths.session(m.session));
  writeJsonAtomic(paths.sessionManifest(m.session), m);
}

export function lookupNative(vendor: string, nativeId: string): string | null {
  try {
    const v = readFileSync(paths.byNativeEntry(vendor, nativeId), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

export function listSessionIds(): string[] {
  if (!existsSync(paths.sessions())) return [];
  return readdirSync(paths.sessions()).filter((n) => /^[0-9a-f-]{36}$/.test(n));
}
