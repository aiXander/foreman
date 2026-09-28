// What the card shows about human batches (plan §9.3): where each one got to, why queued work is
// still waiting, and which stuck deliveries the human may Retry. An unsettled attempt whose
// claimer process is gone is shown as orphaned (uncertain) — it still holds the queue, and nothing
// re-sends it on its own.
import type { ActivityState, BatchStatusView, BatchView, DeliverySummary } from "../shared/api";
import { retryable, UNSEEN_RETRY_MS } from "../shared/delivery";
import { liveness } from "../shared/proc";
import type { TerminalInfo } from "../shared/ptyproto";
import type { JournalState } from "../shared/reducer";
import { batchStatus, queueHead, type Attempt, type BatchState } from "../shared/work";

// Dead stays dead (pid + start time): cache it so recomputes don't call `ps` again.
const deadClaimers = new Set<string>();

function claimerDead(a: Attempt): boolean {
  if (deadClaimers.has(a.attempt_id)) return true;
  const start = a.claimer_start && a.claimer_start !== "unknown" ? a.claimer_start : null;
  if (liveness(a.claimer_pid, start) !== "dead") return false;
  deadClaimers.add(a.attempt_id);
  return true;
}

function statusView(b: BatchState): BatchStatusView {
  const st = batchStatus(b);
  if (st !== "attempting") return st;
  const a = b.attempts.at(-1)!;
  return claimerDead(a) ? "orphaned" : "attempting";
}

const ROUTE_WORDS = { post_tool_use: "a tool-call hook", stop: "the turn-end hook", idle_submit: "the idle prompt" } as const;

function warning(b: BatchState, status: BatchStatusView, now: number): string | null {
  const a = b.attempts.at(-1);
  switch (status) {
    case "orphaned":
      return `The process delivering it through ${ROUTE_WORDS[a!.route]} died before confirming. It may or may not have reached Claude.`;
    case "uncertain":
      return `Delivery through ${ROUTE_WORDS[a!.route]} was not confirmed${a?.detail ? ` (${a.detail})` : ""}. It may already be in the terminal.`;
    case "transport_sent": {
      const sent = b.attempts.findLast((x) => x.outcome === "transport_sent")?.settled_at ?? b.corroborated_at;
      return sent && now - Date.parse(sent) >= UNSEEN_RETRY_MS ? "Handed to Claude but not yet marked seen. The agent may have missed it." : null;
    }
    default:
      return null;
  }
}

export function batchViews(s: JournalState, now = Date.now()): BatchView[] {
  return s.work.batch_order
    .map((id) => s.work.batches[id]!)
    .reverse()
    .map((b) => {
      const status = statusView(b);
      return {
        batch_id: b.batch_id,
        kind: b.kind,
        run: b.run,
        current_run: b.run === s.run,
        status,
        created_at: b.created_at,
        text: b.text,
        actions: b.actions.map((a) => ({
          action_id: a.action_id,
          type: a.type,
          item_id: "item_id" in a ? a.item_id : null,
          acted: b.acted[a.action_id] ? { outcome: b.acted[a.action_id]!.outcome, note: b.acted[a.action_id]!.note } : null,
        })),
        attempts: b.attempts.map((a) => ({ attempt_id: a.attempt_id, route: a.route, claimed_at: a.claimed_at, outcome: a.outcome, detail: a.detail, settled_at: a.settled_at })),
        corroborated_at: b.corroborated_at,
        seen_at: b.seen_at,
        cancelled: b.cancelled,
        retryable: b.run === s.run && retryable(b, { orphaned: status === "orphaned", now }),
        warning: warning(b, status, now),
      };
    });
}

/** Is this batch's latest attempt unsettled by a claimer that has died? (Retry gate.) */
export function isOrphaned(b: BatchState): boolean {
  return statusView(b) === "orphaned";
}

/** Plain-words reason the queued head of the current run hasn't gone out. */
function waitingReason(s: JournalState, state: ActivityState, term: TerminalInfo | null, workerReason: string | null): string {
  if (state === "dead") return "The session has ended; nothing will be delivered.";
  if (state === "waiting_permission") return "A permission prompt is open in the terminal. Answer it there; the batch goes out afterwards.";
  if (s.mode !== "managed") {
    return state === "working" || state === "waiting_input"
      ? "Goes out at the next tool call or when this turn ends."
      : "The session is idle and Foreman never wakes an observed session. Goes out at its next active hook (when it is next prompted).";
  }
  if (!term || term.state !== "live") return "The terminal is not running.";
  if (term.target !== s.target) return "The terminal is not routed to this run yet.";
  if (term.progress === "busy") return "Claude is working. Goes out at the next tool call or when the turn ends.";
  if (term.progress === "idle") return workerReason ? `Idle, but not typing it in: ${workerReason}.` : "Typing it in at the idle prompt…";
  return "Waiting for Claude to report that it is idle.";
}

function heldView(s: JournalState, now: number): DeliverySummary["held"] {
  const head = s.run ? queueHead(s.work, s.run) : null;
  if (!head || !("hold" in head)) return null;
  const b = head.hold;
  const a = b.attempts.at(-1);
  if (head.reason === "paused") {
    const detail = "Sends queued before the Pause wait until you send again (or cancel them).";
    return { batch_id: b.batch_id, reason: "paused", since: b.cancelled?.at ?? a?.settled_at ?? b.created_at, detail };
  }
  const reason = head.reason === "attempting" && isOrphaned(b) ? "orphaned" : head.reason;
  return { batch_id: b.batch_id, reason, since: a?.claimed_at ?? b.created_at, detail: warning(b, reason, now) };
}

export function deliverySummary(s: JournalState, state: ActivityState, term: TerminalInfo | null, workerReason: string | null, now = Date.now()): DeliverySummary | null {
  let queued = 0;
  let unseen = 0;
  let oldRun = 0;
  for (const id of s.work.batch_order) {
    const b = s.work.batches[id]!;
    const st = batchStatus(b);
    if (b.run !== s.run) oldRun += st === "queued" ? 1 : 0;
    else if (st === "queued") queued++;
    else if (st === "transport_sent" && warning(b, st, now)) unseen++;
  }
  const held = heldView(s, now);
  if (!queued && !unseen && !oldRun && !held) return null;
  const waiting = queued && !held ? waitingReason(s, state, term, workerReason) : null;
  return { queued, waiting, held, unseen, old_run: oldRun };
}
