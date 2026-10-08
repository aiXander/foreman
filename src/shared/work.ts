// Declared work and human steering, folded from the session journal: brief, progress, items,
// handover (what the agent reports through MCP) and batches with their delivery attempts and
// receipts (what the human sent and how far it got). Pure: liveness and terminals are the
// daemon's business. The queue rules here are the single definition every consumer claims by.
import type { Stored } from "./journal";
import type { Ack, BatchAction, StoredItem } from "./protocol";

export interface BriefState {
  goal: string;
  done_when: string;
  source: string | null;
  checklist: { id: string; label: string }[];
  at: string;
  /** How many briefs this session has declared (replans = revision - 1). */
  revision: number;
}

export interface ProgressState {
  progress: number;
  confidence: "low" | "med" | "high";
  now: string;
  eta_min: number[] | null;
  phase: string | null;
  checked: string[];
  at: string;
}

/** A human action (from a sent batch) that targets this item, with the agent's receipt. */
export interface ItemHumanAction {
  batch_id: string;
  action_id: string;
  type: BatchAction["type"];
  option_id: string | null;
  text: string | null;
  outcome: Ack["outcome"] | null;
  note: string | null;
}

export type ItemState = StoredItem & {
  created_at: string;
  updated_at: string;
  resolved: { outcome: string; reason: string | null; superseded_by: string | null; at: string } | null;
  /** Revision the human marked reviewed (decisions); a newer revision is unreviewed again. */
  reviewed_revision: number | null;
  human: ItemHumanAction[];
};

export interface Attempt {
  attempt_id: string;
  route: "post_tool_use" | "stop" | "idle_submit";
  seq: number;
  claimed_at: string;
  claimer_pid: number;
  claimer_start: string | null;
  outcome: "transport_sent" | "failed" | "uncertain" | null;
  detail: string | null;
  settled_at: string | null;
}

export interface BatchState {
  batch_id: string;
  run: string;
  kind: "send" | "pause";
  /** `page`: a tell from the session's page; null = the send tray or Pause. */
  via: "page" | null;
  /** The page-edit diff at the top of `text` (P2b), or null. */
  edits: string | null;
  actions: BatchAction[];
  text: string;
  created_at: string;
  seq: number;
  attempts: Attempt[];
  /** seq of the latest explicit Retry; attempts claimed before it no longer hold the queue. */
  retry_seq: number | null;
  /** `auto`: a pause made moot (the session was already idle, or the human typed a new prompt). */
  cancelled: { reason: string; by: "human" | "auto"; at: string } | null;
  corroborated_at: string | null;
  /** seq of the latest UserPromptSubmit marker sighting; confirms the attempt claimed before it. */
  corroborated_seq: number | null;
  seen_at: string | null;
  acted: Record<string, { outcome: NonNullable<Ack["outcome"]>; note: string | null; at: string }>;
}

export interface HandoverState {
  summary_md: string;
  what_changed: string[];
  how_to_verify: string[];
  evidence: { label: string; ref: string }[];
  next_prompt: string | null;
  docs_touched: string[];
  open_items_carried: string[];
  at: string;
  revision: number;
}

export interface WorkState {
  brief: BriefState | null;
  progress: ProgressState | null;
  items: Record<string, ItemState>;
  item_order: string[];
  handover: HandoverState | null;
  batches: Record<string, BatchState>;
  batch_order: string[];
}

export const emptyWork = (): WorkState => ({ brief: null, progress: null, items: {}, item_order: [], handover: null, batches: {}, batch_order: [] });

export const WORK_EVENTS = new Set([
  "brief.set",
  "progress.set",
  "item.put",
  "item.resolved",
  "item.reviewed",
  "handover.set",
  "batch.created",
  "batch.retry",
  "batch.cancelled",
  "delivery.claimed",
  "delivery.settled",
  "delivery.corroborated",
  "batch.acked",
]);

const ITEM_ACTIONS = new Set(["answer", "revisit", "offer_accept", "offer_decline", "ship_ack"]);

export function reduceWork(w: WorkState, e: Stored): void {
  const p = e.payload as any;
  switch (e.type) {
    case "brief.set": {
      const ids = new Set((p.checklist ?? []).map((c: any) => c.id));
      w.brief = { goal: p.goal, done_when: p.done_when, source: p.source ?? null, checklist: p.checklist ?? [], at: e.ts, revision: (w.brief?.revision ?? 0) + 1 };
      // Replanning keeps only the checked ids that survive in the new checklist.
      if (w.progress) w.progress.checked = w.progress.checked.filter((id) => ids.has(id));
      return;
    }
    case "progress.set": {
      const prev = w.progress;
      w.progress = {
        progress: p.progress,
        confidence: p.confidence,
        now: p.now,
        // Optional fields: omitted = unchanged, null = cleared.
        eta_min: p.eta_min === undefined ? (prev?.eta_min ?? null) : p.eta_min,
        phase: p.phase === undefined ? (prev?.phase ?? null) : p.phase,
        checked: p.checked === undefined ? (prev?.checked ?? []) : p.checked,
        at: e.ts,
      };
      return;
    }
    case "item.put": {
      const prev = w.items[p.id];
      if (!prev) w.item_order.push(p.id);
      w.items[p.id] = { ...p, created_at: prev?.created_at ?? e.ts, updated_at: e.ts, resolved: null, reviewed_revision: prev?.reviewed_revision ?? null, human: prev?.human ?? [] };
      return;
    }
    case "item.resolved": {
      const it = w.items[p.id];
      if (!it) return;
      it.revision = p.revision;
      it.updated_at = e.ts;
      it.resolved = { outcome: p.outcome, reason: p.reason, superseded_by: p.superseded_by, at: e.ts };
      return;
    }
    case "item.reviewed": {
      const it = w.items[p.id];
      if (it && it.revision === p.revision) it.reviewed_revision = p.revision;
      return;
    }
    case "handover.set":
      w.handover = { ...p, next_prompt: p.next_prompt ?? null, at: e.ts, revision: (w.handover?.revision ?? 0) + 1 };
      return;
    case "batch.created": {
      if (w.batches[p.batch_id]) return;
      w.batches[p.batch_id] = {
        batch_id: p.batch_id,
        run: p.run,
        kind: p.kind,
        via: p.via ?? null,
        edits: p.edits ?? null,
        actions: p.actions,
        text: p.text,
        created_at: e.ts,
        seq: e.seq,
        attempts: [],
        retry_seq: null,
        cancelled: null,
        corroborated_at: null,
        corroborated_seq: null,
        seen_at: null,
        acted: {},
      };
      w.batch_order.push(p.batch_id);
      for (const a of p.actions as BatchAction[]) {
        if (!ITEM_ACTIONS.has(a.type) || !("item_id" in a)) continue;
        w.items[a.item_id]?.human.push({
          batch_id: p.batch_id,
          action_id: a.action_id,
          type: a.type,
          option_id: "option_id" in a ? (a.option_id ?? null) : null,
          text: "text" in a ? (a.text ?? null) : null,
          outcome: null,
          note: null,
        });
      }
      return;
    }
    case "batch.retry": {
      const b = w.batches[p.batch_id];
      if (b) b.retry_seq = e.seq;
      return;
    }
    case "batch.cancelled": {
      const b = w.batches[p.batch_id];
      if (!b || b.cancelled) return;
      b.cancelled = { reason: p.reason, by: p.by ?? "human", at: e.ts };
      // Only never-delivered batches are cancelled: their item actions were never sent after all
      // (a retarget re-adds them under the new batch).
      for (const a of b.actions) if ("item_id" in a && w.items[a.item_id]) w.items[a.item_id]!.human = w.items[a.item_id]!.human.filter((h) => h.batch_id !== b.batch_id);
      return;
    }
    case "delivery.claimed": {
      w.batches[p.batch_id]?.attempts.push({
        attempt_id: p.attempt_id,
        route: p.route,
        seq: e.seq,
        claimed_at: e.ts,
        claimer_pid: p.claimer_pid,
        claimer_start: p.claimer_start,
        outcome: null,
        detail: null,
        settled_at: null,
      });
      return;
    }
    case "delivery.settled": {
      const a = w.batches[p.batch_id]?.attempts.find((x) => x.attempt_id === p.attempt_id);
      if (a && a.outcome === null) Object.assign(a, { outcome: p.outcome, detail: p.detail, settled_at: e.ts });
      return;
    }
    case "delivery.corroborated": {
      const b = w.batches[p.batch_id];
      if (!b) return;
      b.corroborated_at ??= e.ts;
      b.corroborated_seq = e.seq;
      return;
    }
    case "batch.acked": {
      const b = w.batches[p.batch_id];
      if (!b) return;
      b.seen_at ??= e.ts; // acted implies seen; receipts never regress
      if (p.state !== "acted") return;
      for (const id of p.action_ids as string[]) {
        if (b.acted[id]) continue;
        b.acted[id] = { outcome: p.outcome, note: p.note, at: e.ts };
        const act = b.actions.find((a) => a.action_id === id);
        const it = act && "item_id" in act ? w.items[act.item_id] : undefined;
        const h = it?.human.find((x) => x.action_id === id);
        if (h) Object.assign(h, { outcome: p.outcome, note: p.note });
      }
      return;
    }
  }
}

// ---------- derived views ----------

export type BatchStatus = "queued" | "attempting" | "uncertain" | "transport_sent" | "seen" | "acted" | "cancelled";

/** The attempt that still counts: one claimed after the latest explicit Retry, if any. */
function liveAttempt(b: BatchState): Attempt | null {
  const a = b.attempts.at(-1);
  if (!a || (b.retry_seq !== null && a.seq < b.retry_seq)) return null;
  return a;
}

export function batchStatus(b: BatchState): BatchStatus {
  if (b.cancelled) return "cancelled";
  if (b.actions.every((a) => b.acted[a.action_id])) return "acted";
  if (b.seen_at) return "seen";
  const a = liveAttempt(b);
  if (!a || a.outcome === "failed") return "queued";
  if (a.outcome === "transport_sent") return "transport_sent";
  // The prompt carrying this batch's marker was submitted after the claim: transport is proven
  // even if the submit itself timed out waiting for confirmation (or its claimer died).
  if (b.corroborated_seq !== null && b.corroborated_seq > a.seq) return "transport_sent";
  return a.outcome === null ? "attempting" : "uncertain";
}

export type QueueHead = { batch: BatchState } | { hold: BatchState; reason: "attempting" | "uncertain" | "paused" } | null;

/**
 * What the next consumer for `run` may deliver. One in-flight batch per run: an unsettled or
 * uncertain attempt holds the queue until it settles or the human explicitly retries. Pauses go
 * ahead of ordinary sends; otherwise FIFO. Batches sent to another run wait for a retarget.
 * A pause that went out (or was made moot) parks the sends queued before it: they wait until the
 * human sends again, which releases them in order (D18: "start no new work until the human sends more").
 */
export function queueHead(w: WorkState, run: string): QueueHead {
  const mine = w.batch_order.map((id) => w.batches[id]!).filter((b) => b.run === run);
  let parkedBy: BatchState | null = null;
  for (const b of mine) {
    const s = batchStatus(b);
    if (s === "attempting" || s === "uncertain") return { hold: b, reason: s };
    if (b.kind === "pause" && s !== "queued" && (s !== "cancelled" || b.cancelled!.by === "auto")) parkedBy = b;
  }
  const queued = mine.filter((b) => batchStatus(b) === "queued");
  const pause = queued.find((b) => b.kind === "pause");
  if (pause) return { batch: pause };
  if (!queued.length) return null;
  if (parkedBy && !queued.some((b) => b.seq > parkedBy.seq)) return { hold: parkedBy, reason: "paused" };
  return { batch: queued[0]! };
}

/** Questions, unreviewed decisions, blockers, offers, unfixed issues and ships (§8.3). */
export function isActionable(it: ItemState): boolean {
  if (it.resolved) return false;
  switch (it.body.kind) {
    case "decision":
      return it.reviewed_revision !== it.revision;
    case "issue":
      return it.body.handled !== "fixed";
    case "note":
    case "deliverable":
      return false;
    default:
      return true;
  }
}

export function openCounts(w: WorkState): { questions: number; unreviewedDecisions: number; actionable: number } {
  let questions = 0;
  let unreviewedDecisions = 0;
  let actionable = 0;
  for (const id of w.item_order) {
    const it = w.items[id]!;
    if (!isActionable(it)) continue;
    actionable++;
    if (it.body.kind === "question") questions++;
    if (it.body.kind === "decision") unreviewedDecisions++;
  }
  return { questions, unreviewedDecisions, actionable };
}
