// Human batches and their delivery (plan §9), on the session journal. The proven rule from
// phase 0: every consumer (PostToolUse hook, Stop hook, daemon idle worker) claims the head batch
// under the session lock and fsyncs the claim BEFORE producing any output; an unsettled or
// uncertain claim holds the queue. No lock is ever held while writing stdout or a PTY.
import { readFileSync } from "node:fs";
import type { Payload } from "./events";
import { validatePayload } from "./events";
import type { Draft, Stored } from "./journal";
import { paths } from "./paths";
import { selfStart } from "./proc";
import { BatchAction, MAX_BATCH_ACTIONS, MAX_BATCH_TEXT_BYTES, MAX_TELL_TEXT, ToolError } from "./protocol";
import { foldJournal, type JournalState } from "./reducer";
import { LOCK_TIMEOUT, sessionJournal } from "./store";
import { batchStatus, queueHead, reduceWork, type BatchState, type WorkState } from "./work";

export type Route = Payload<"delivery.claimed">["route"];

const marker = (batchId: string) => `[foreman batch ${batchId}]`;
const MARKER_RE = /\[foreman batch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g;

/** Batch ids named by `[foreman batch <id>]` markers in a prompt (only the ids are ever kept). */
export function batchMarkers(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(MARKER_RE)].map((m) => m[1]!))].slice(0, 20);
}

/** Before-2-minutes a sent batch without a model `seen` is normal; after, the UI offers Retry (§9.3). */
export const UNSEEN_RETRY_MS = 2 * 60_000;

// ---------- rendering (frozen into batch.created; the preview shows exactly this) ----------

const quote = (s: string) => `"${s}"`;

/** One action as the agent reads it (also the tray's per-action label). */
export function renderAction(a: BatchAction, w: WorkState): string {
  const it = "item_id" in a ? w.items[a.item_id] : undefined;
  const ref = it && "item_revision" in a ? `${quote(it.title)} (item ${it.id}, revision ${a.item_revision})` : "";
  switch (a.type) {
    case "answer": {
      const opt = it?.body.kind === "question" && a.option_id ? it.body.options.find((o) => o.id === a.option_id) : undefined;
      const choice = opt ? `option ${quote(opt.label)} (${opt.id})` : a.option_id ? `option ${a.option_id}` : "";
      return `Answer to ${ref}: ${[choice, a.text].filter(Boolean).join(" — ")}`;
    }
    case "revisit":
      return `Revisit ${ref}: ${a.text}`;
    case "offer_accept":
      return `Accept offer ${ref}. Do it within the scope you already have.`;
    case "offer_decline":
      return `Decline offer ${ref}.`;
    case "ship_ack":
      return `Ship ${ref}: the human says they ran it.`;
    case "note":
      return `Note: ${a.text}`;
    case "pause":
      return "Pause: finish or safely stop your current step, record progress with foreman_progress, then end your turn. Start no new work until the human sends more.";
  }
}

/**
 * A page's tell as the note action's text: `[page <title>] <text>` plus `context: <compact JSON>`.
 * The note action's 2,000-character limit applies to the whole thing.
 */
export function tellNote(title: string, text: string, context?: unknown): string {
  const body = text.trim();
  if (!body) throw new ToolError("VALIDATION", "a tell needs text", "text");
  let ctx = "";
  if (context !== undefined) {
    const json = JSON.stringify(context);
    if (json === undefined) throw new ToolError("VALIDATION", "context must be JSON", "context");
    ctx = `\ncontext: ${json}`;
  }
  const note = `[page ${title}] ${body}${ctx}`;
  if (note.length > MAX_TELL_TEXT) throw new ToolError("LIMIT", `a tell renders to ${note.length} characters; at most ${MAX_TELL_TEXT} (title, text and context together)`, "text");
  return note;
}

// Control characters (ESC could end a bracketed paste) never enter the frozen text, so every
// batch stays typeable by ptyd's idle submit; CRLF becomes LF.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The exact text `createBatch` freezes for these actions against this state (the tray preview). */
export function renderBatch(actions: BatchAction[], w: WorkState): string {
  const lines = actions.map((a, i) => `${i + 1}. ${renderAction(a, w)} [action ${a.action_id}]`);
  const text = [...lines, "When done, acknowledge with foreman_inbox: seen, then acted for each action (applied, declined or blocked + note)."].join("\n");
  return text.replace(/\r\n?/g, "\n").replace(CONTROL, "\ufffd");
}

/** Hook routes: marker + provenance line, then the frozen batch text (§9.2). */
export function hookContext(b: Pick<BatchState, "batch_id" | "text">, route: "post_tool_use" | "stop"): string {
  const when = route === "stop" ? "as you were finishing your turn" : "while you were working";
  return `${marker(b.batch_id)} The human sent this from the Foreman UI ${when}. It is their instruction; act on it:\n${b.text}`;
}

/**
 * Idle route: the one-line lead typed before the body (ptyd `submit`). It stays the human's own
 * words, so the model acts on the body even when Claude wraps it as `<pasted_content>` (§9.2).
 */
export function idleLead(batchId: string): string {
  return `${marker(batchId)} The human sent this from the Foreman UI; it is their instruction, act on it:`;
}

// ---------- queue mutations ----------

export interface NewBatch {
  batch_id: string;
  run: string;
  kind: "send" | "pause";
  actions: BatchAction[];
  via?: "page";
}

/** Why a staged item action can no longer be sent as-is (the item moved on), or null. */
export function staleReason(a: BatchAction, w: WorkState): string | null {
  if (!("item_id" in a)) return null;
  const it = w.items[a.item_id];
  if (!it) return `item ${a.item_id} no longer exists`;
  if (it.revision !== a.item_revision || it.resolved) {
    return `item ${quote(it.title)} changed since you staged this (now revision ${it.revision}${it.resolved ? ", resolved" : ""})`;
  }
  return null;
}

/** Validate against the current run and item revisions, render, and draft `batch.created`. Inside a transaction. */
function freeze(s: JournalState | null, session: string, nb: NewBatch): Draft {
  if (!s) throw new ToolError("NOT_REGISTERED", "unknown session");
  if (s.run !== nb.run || s.state === "dead") throw new ToolError("STALE_TARGET", "the session has moved to another run or ended; review the tray against the current run");
  for (const a of nb.actions) {
    const stale = staleReason(a, s.work);
    if (stale) throw new ToolError("CONFLICT", stale, a.action_id);
  }
  const text = renderBatch(nb.actions, s.work);
  if (Buffer.byteLength(text) > MAX_BATCH_TEXT_BYTES) throw new ToolError("LIMIT", `batch text exceeds ${MAX_BATCH_TEXT_BYTES} bytes`);
  const payload = validatePayload("batch.created", { batch_id: nb.batch_id, run: nb.run, kind: nb.kind, actions: nb.actions, text, ...(nb.via ? { via: nb.via } : {}) });
  return { type: "batch.created", payload, fields: { session, run: nb.run, source: "daemon" } };
}

const parseActions = (actions: BatchAction[]) => {
  const parsed = actions.map((a) => BatchAction.parse(a));
  if (!parsed.length || parsed.length > MAX_BATCH_ACTIONS) throw new ToolError("LIMIT", `a batch holds 1–${MAX_BATCH_ACTIONS} actions`);
  return parsed;
};
const sha = (v: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(v)).digest("hex");

/**
 * Freeze a Send (§9.1): validate target run and item revisions against current state, render
 * the exact text and append `batch.created` durably. Idempotent per batch_id (HTTP retries).
 */
export function createBatch(session: string, nb: NewBatch): { batch: BatchState; replayed: boolean } {
  const actions = parseActions(nb.actions);
  const tx = sessionJournal(session).transact((events) => ({ drafts: [freeze(foldJournal(events), session, { ...nb, actions })], result: null }), {
    lockTimeoutMs: LOCK_TIMEOUT.mutation,
    durable: true,
    request: { id: nb.batch_id, hash: sha(nb.via ? [nb.run, nb.kind, actions, nb.via] : [nb.run, nb.kind, actions]) },
  });
  const batch = foldJournal(sessionJournal(session).readAll())!.work.batches[nb.batch_id]!;
  return { batch, replayed: tx.replayed };
}

/** Human cancel: only a batch nothing has been handed over for (queued), on any run. */
export function cancelBatch(session: string, batchId: string, reason = "cancelled by the human"): void {
  sessionJournal(session).transact(
    (events) => {
      const s = foldJournal(events);
      const b = s?.work.batches[batchId];
      if (!s || !b) throw new ToolError("NOT_REGISTERED", "unknown batch");
      if (b.cancelled) return { drafts: [], result: null }; // already cancelled: idempotent
      const st = batchStatus(b);
      if (st !== "queued") throw new ToolError("CONFLICT", `batch is ${st}; only a batch that was never handed over can be cancelled`);
      const payload = validatePayload("batch.cancelled", { batch_id: batchId, reason, by: "human" });
      return { drafts: [{ type: "batch.cancelled", payload, fields: { session, run: s.run, source: "daemon" } }], result: null };
    },
    { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true },
  );
}

/**
 * Move a never-delivered send from an earlier run to the current one (plan §6.2): cancel the old
 * batch and create `newBatchId` (fresh action ids, re-validated and re-rendered against current
 * state) in one transaction. It joins the back of the current run's queue. Idempotent per newBatchId.
 */
export function retargetBatch(session: string, oldBatchId: string, newBatchId: string): { batch: BatchState; replayed: boolean } {
  const tx = sessionJournal(session).transact(
    (events) => {
      const s = foldJournal(events);
      const b = s?.work.batches[oldBatchId];
      if (!s?.run || !b) throw new ToolError("NOT_REGISTERED", "unknown batch");
      if (b.run === s.run) throw new ToolError("CONFLICT", "this batch already belongs to the current run");
      if (b.kind === "pause") throw new ToolError("CONFLICT", "a Pause for an earlier run is moot; cancel it instead");
      const st = batchStatus(b);
      if (st !== "queued") throw new ToolError("CONFLICT", `batch is ${st}; only a batch that was never handed over can be retargeted`);
      const actions = b.actions.map((a) => ({ ...a, action_id: crypto.randomUUID() }));
      const created = freeze(s, session, { batch_id: newBatchId, run: s.run, kind: "send", actions, ...(b.via ? { via: b.via } : {}) });
      const cancel = validatePayload("batch.cancelled", { batch_id: oldBatchId, reason: `moved to the current run as batch ${newBatchId}`, by: "human" });
      return { drafts: [{ type: "batch.cancelled", payload: cancel, fields: { session, run: s.run, source: "daemon" } }, created], result: null };
    },
    { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true, request: { id: newBatchId, hash: sha(["retarget", oldBatchId]) } },
  );
  const batch = foldJournal(sessionJournal(session).readAll())!.work.batches[newBatchId]!;
  return { batch, replayed: tx.replayed };
}

export interface Claim {
  session: string;
  run: string;
  batch_id: string;
  attempt_id: string;
  route: Route;
  text: string;
}

const sourceFor = (route: Route) => (route === "idle_submit" ? "daemon" : "hook");

/**
 * Cheap unlocked read of just the queue-relevant state. PostToolUse runs this on every tool call,
 * so it skips the whole fold when the journal never had a batch, and never parses the (bulk)
 * activity lines. A torn or odd line is skipped: this is only a hint — every decision is re-made
 * under the lock by `transact`.
 */
function peekQueue(session: string): JournalState | null {
  let text: string;
  try {
    text = readFileSync(paths.sessionJournal(session), "utf8");
  } catch {
    return null;
  }
  if (!text.includes('"type":"batch.created"')) return null;
  const events: Stored[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.includes('"type":"activity","payload"')) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return foldJournal(events);
}

/** A pause only ever parks a running turn; at a turn's end or on an idle prompt it is moot (D18). */
function mootReason(route: Route): string | null {
  if (route === "stop") return "the turn was already ending";
  if (route === "idle_submit") return "the session was already idle";
  return null;
}

/** Cancel `b` as moot inside a transaction, applying it to `s` so the caller can look again. */
function mootDraft(s: JournalState, b: BatchState, reason: string, source: "hook" | "daemon"): Draft {
  const payload = validatePayload("batch.cancelled", { batch_id: b.batch_id, reason, by: "auto" });
  reduceWork(s.work, { v: 1, id: crypto.randomUUID(), seq: s.last_seq + 1, ts: new Date().toISOString(), type: "batch.cancelled", payload });
  return { type: "batch.cancelled", payload, fields: { session: s.session, run: s.run, source } };
}

/**
 * Claim the head batch for `route`, or null (empty, held by an in-flight/uncertain attempt or a
 * pause, run not current). The claim is fsynced before this returns — only then may the caller
 * produce output. `expectRun` pins the claim to a run the caller already verified (the idle
 * worker's terminal route). A pause at the head of a Stop or idle claim is cancelled as moot
 * instead of starting work only to stop it.
 */
export function claimNext(session: string, route: Route, opts: { expectRun?: string; lockTimeoutMs?: number } = {}): Claim | null {
  // Most hooks find nothing and must not contend the lock.
  const peek = peekQueue(session);
  const hint = peek?.run && peek.state !== "dead" ? queueHead(peek.work, peek.run) : null;
  if (!hint || !("batch" in hint)) return null;
  const start = selfStart(); // a `ps` call: never while holding the lock
  const tx = sessionJournal(session).transact(
    (events) => {
      const s = foldJournal(events);
      const drafts: Draft[] = [];
      if (!s?.run || s.state === "dead" || (opts.expectRun && s.run !== opts.expectRun)) return { drafts, result: null };
      let head = queueHead(s.work, s.run);
      const moot = mootReason(route);
      if (moot && head && "batch" in head && head.batch.kind === "pause") {
        drafts.push(mootDraft(s, head.batch, moot, sourceFor(route)));
        head = queueHead(s.work, s.run);
      }
      if (!head || !("batch" in head) || (moot && head.batch.kind === "pause")) return { drafts, result: null };
      const attempt_id = crypto.randomUUID();
      const payload = validatePayload("delivery.claimed", { batch_id: head.batch.batch_id, attempt_id, route, claimer_pid: process.pid, claimer_start: start || null });
      drafts.push({ type: "delivery.claimed", payload, fields: { session, run: s.run, source: sourceFor(route) } });
      const claim: Claim = { session, run: s.run, batch_id: head.batch.batch_id, attempt_id, route, text: head.batch.text };
      return { drafts, result: claim };
    },
    { lockTimeoutMs: opts.lockTimeoutMs ?? LOCK_TIMEOUT.passive, durable: true },
  );
  return tx.result;
}

/**
 * UserPromptSubmit: record `[foreman batch <id>]` markers as transport corroboration of this
 * session's batches (ids only), and — when the human typed a prompt of their own (no marker) —
 * cancel a queued pause as moot: they are steering directly now.
 */
export function onUserPrompt(session: string, markers: string[]): void {
  const peek = peekQueue(session);
  if (!peek?.run) return;
  const known = markers.filter((id) => peek.work.batches[id] && !peek.work.batches[id]!.corroborated_at);
  const head = queueHead(peek.work, peek.run);
  const pauseQueued = !markers.length && !!head && "batch" in head && head.batch.kind === "pause";
  if (!known.length && !pauseQueued) return;
  sessionJournal(session).transact(
    (events) => {
      const s = foldJournal(events);
      const drafts: Draft[] = [];
      if (!s) return { drafts, result: null };
      for (const id of known) {
        const b = s.work.batches[id];
        if (!b || b.corroborated_at) continue;
        drafts.push({ type: "delivery.corroborated", payload: validatePayload("delivery.corroborated", { batch_id: id, via: "user_prompt_submit" }), fields: { session, run: s.run, source: "hook" } });
      }
      const h = s.run && pauseQueued ? queueHead(s.work, s.run) : null;
      if (h && "batch" in h && h.batch.kind === "pause") drafts.push(mootDraft(s, h.batch, "the human typed a new prompt", "hook"));
      return { drafts, result: null };
    },
    { lockTimeoutMs: LOCK_TIMEOUT.passive, durable: true },
  );
}

/** Record how an attempt ended. `uncertain` keeps holding the queue until an explicit Retry. */
export function settle(c: Pick<Claim, "session" | "run" | "batch_id" | "attempt_id" | "route">, outcome: Payload<"delivery.settled">["outcome"], detail: string | null = null): void {
  const payload = validatePayload("delivery.settled", { batch_id: c.batch_id, attempt_id: c.attempt_id, outcome, detail: detail?.slice(0, 300) || null });
  sessionJournal(c.session).append([{ type: "delivery.settled", payload, fields: { session: c.session, run: c.run, source: c.route === "idle_submit" ? "daemon" : "hook" } }], {
    lockTimeoutMs: LOCK_TIMEOUT.mutation,
    durable: true,
  });
}

/**
 * Explicit human Retry (§9.3): the batch becomes claimable again with the same batch/action ids,
 * and the next claim is a new attempt. It may duplicate transport — the UI says so; nothing
 * retries on its own. Retryable: an uncertain attempt; an unsettled one whose claimer the caller
 * found dead (`orphaned`); a sent one the model has not marked seen for UNSEEN_RETRY_MS.
 */
export function retryBatch(session: string, batchId: string, opts: { orphaned?: boolean; now?: number } = {}): void {
  sessionJournal(session).transact(
    (events) => {
      const s = foldJournal(events);
      const b = s?.work.batches[batchId];
      if (!s || !b) throw new ToolError("NOT_REGISTERED", "unknown batch");
      if (b.run !== s.run) throw new ToolError("STALE_TARGET", "this batch was sent to an earlier run; retarget or cancel it instead");
      if (!retryable(b, { orphaned: opts.orphaned ?? false, now: opts.now ?? Date.now() })) {
        throw new ToolError("CONFLICT", `batch is ${batchStatus(b)}; only an uncertain, orphaned or long-unseen delivery can be retried`);
      }
      return { drafts: [{ type: "batch.retry", payload: validatePayload("batch.retry", { batch_id: batchId }), fields: { session, run: s.run, source: "daemon" } }], result: null };
    },
    { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true },
  );
}

export function retryable(b: BatchState, o: { orphaned: boolean; now: number }): boolean {
  const st = batchStatus(b);
  if (st === "uncertain") return true;
  if (st === "attempting") return o.orphaned;
  if (st !== "transport_sent") return false;
  const sent = b.attempts.findLast((a) => a.outcome === "transport_sent")?.settled_at ?? b.corroborated_at;
  return !!sent && o.now - Date.parse(sent) >= UNSEEN_RETRY_MS;
}

/**
 * The human marks a decision revision reviewed (plan §8.3): a local review that takes it off the
 * needs-you list without steering the agent. A newer revision is unreviewed again.
 */
export function markReviewed(session: string, itemId: string, revision: number): void {
  sessionJournal(session).transact(
    (events) => {
      const s = foldJournal(events);
      const it = s?.work.items[itemId];
      if (!s || !it) throw new ToolError("NOT_REGISTERED", "unknown item");
      if (it.body.kind !== "decision") throw new ToolError("VALIDATION", "only decisions are marked reviewed");
      if (it.revision !== revision || it.resolved) throw new ToolError("CONFLICT", `the decision changed (now revision ${it.revision}${it.resolved ? ", resolved" : ""}); look at it again`);
      if (it.reviewed_revision === revision) return { drafts: [], result: null };
      const payload = validatePayload("item.reviewed", { id: itemId, revision });
      return { drafts: [{ type: "item.reviewed", payload, fields: { session, run: s.run, source: "daemon" } }], result: null };
    },
    { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true },
  );
}
