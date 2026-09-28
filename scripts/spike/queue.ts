// Spike batch queue (throwaway): one append-only JSONL per native session, every consumer
// (PostToolUse hook, Stop hook, idle-submit worker) claims under the same directory lock the
// real journals use, and the claim is appended BEFORE any side effect. An in-flight claim
// (claimed, no terminal outcome) holds the queue: nothing else is delivered after it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../../src/shared/lock";

const FH = process.env.FOREMAN_HOME ?? "/tmp/fh";
const QDIR = join(FH, "spike", "queue");

export type Route = "PostToolUse" | "Stop" | "idle_submit" | "UserPromptSubmit";
type Rec =
  | { type: "queued"; batch_id: string; text: string; at: string }
  | { type: "claimed"; batch_id: string; attempt: string; route: Route; pid: number; at: string }
  | { type: "sent"; batch_id: string; attempt: string; at: string }
  | { type: "failed"; batch_id: string; attempt: string; reason: string; at: string };

const file = (native: string) => join(QDIR, `${native}.jsonl`);
const lock = (native: string) => join(QDIR, `${native}.lock`);

function read(native: string): Rec[] {
  if (!existsSync(file(native))) return [];
  return readFileSync(file(native), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function put(native: string, r: Rec): void {
  mkdirSync(QDIR, { recursive: true });
  appendFileSync(file(native), JSON.stringify(r) + "\n");
}

export function enqueue(native: string, text: string, batch_id: string = crypto.randomUUID()): string {
  withLock(lock(native), 2000, () => put(native, { type: "queued", batch_id, text, at: new Date().toISOString() }));
  return batch_id;
}

export interface Claim {
  batch_id: string;
  attempt: string;
  text: string;
}

/** Oldest unclaimed batch, or null when empty or when an earlier attempt is still in flight. */
export function claimNext(native: string, route: Route, timeoutMs = 250): Claim | null {
  return withLock(lock(native), timeoutMs, () => {
    const recs = read(native);
    const claimed = new Map<string, string>();
    const done = new Set<string>();
    for (const r of recs) {
      if (r.type === "claimed") claimed.set(r.batch_id, r.attempt);
      if (r.type === "sent") done.add(r.batch_id);
      if (r.type === "failed") claimed.delete(r.batch_id); // definitive failure: eligible again
    }
    for (const [b] of claimed) if (!done.has(b)) return null; // uncertain attempt holds the queue
    const next = recs.find((r) => r.type === "queued" && !claimed.has(r.batch_id)) as Extract<Rec, { type: "queued" }> | undefined;
    if (!next) return null;
    const attempt = crypto.randomUUID();
    put(native, { type: "claimed", batch_id: next.batch_id, attempt, route, pid: process.pid, at: new Date().toISOString() });
    return { batch_id: next.batch_id, attempt, text: next.text };
  });
}

export function settle(native: string, c: Claim, ok: true | string): void {
  withLock(lock(native), 2000, () =>
    put(native, ok === true ? { type: "sent", batch_id: c.batch_id, attempt: c.attempt, at: new Date().toISOString() } : { type: "failed", batch_id: c.batch_id, attempt: c.attempt, reason: ok, at: new Date().toISOString() }),
  );
}

export function history(native: string): Rec[] {
  return read(native);
}

export const marker = (batch_id: string) => `[foreman batch ${batch_id}]`;
export const MARKER_RE = /\[foreman batch ([0-9a-f-]{36})\]/g;
