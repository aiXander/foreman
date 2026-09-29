// What the human sent and how far each batch got (plan §9.3): queued → handed to Claude → seen →
// acted (with the agent's declined/blocked notes), why queued work is waiting, an explicit Retry for
// stuck deliveries (never automatic; may duplicate), Cancel for anything not yet handed over, and
// Move-to-current-run for sends made to an earlier run of this conversation.
import { useState } from "react";
import type { BatchStatusView, BatchView, SessionView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { relTime } from "../format";

const statusLabel: Record<BatchStatusView, string> = {
  queued: "Queued",
  attempting: "Delivering…",
  orphaned: "Delivery uncertain",
  uncertain: "Delivery uncertain",
  transport_sent: "Handed to Claude",
  seen: "Seen by the agent",
  acted: "Acted on",
  cancelled: "Cancelled",
};

/** Which signal colour a status chip borrows (via the lamp's data-state palette). */
const statusTone: Record<BatchStatusView, string> = {
  queued: "idle",
  attempting: "starting",
  orphaned: "waiting_input",
  uncertain: "waiting_input",
  transport_sent: "starting",
  seen: "starting",
  acted: "working",
  cancelled: "dead",
};

const routeLabel ={ post_tool_use: "during a tool call", stop: "at turn end", idle_submit: "typed at the idle prompt" } as const;

interface Props {
  s: SessionView;
  batches: BatchView[];
  now: number;
  onOpenTerminal: (() => void) | null;
  onChanged: () => void;
  onUnauthorized: () => void;
}

export function Deliveries({ s, batches, now, onOpenTerminal, onChanged, onUnauthorized }: Props) {
  const d = s.delivery;
  if (!d && batches.length === 0) return null;
  return (
    <section className="mt-7">
      <h2 className="eyebrow mb-2.5">Sent to the agent</h2>
      {d?.held ? (
        <p className="mb-2.5 rounded-md bg-warn-bg px-2.5 py-1.5 text-[13px]">
          {d.held.reason === "paused"
            ? `Paused. ${d.held.detail}`
            : d.held.reason === "attempting"
              ? "Delivering…"
              : "A delivery is unconfirmed (below); later sends wait until you retry it or it is confirmed."}
        </p>
      ) : null}
      {d?.waiting ? <p className="mb-2.5 text-[13px] text-ink-2">{`${d.queued} queued. ${d.waiting}`}</p> : null}
      {d && d.old_run > 0 ? (
        <p className="mb-2.5 text-[13px] text-ink-3">{`${d.old_run} sent to an earlier run of this conversation and not delivered: move ${d.old_run === 1 ? "it" : "them"} to the current run or cancel (below).`}</p>
      ) : null}
      <ol className="space-y-2">
        {batches.slice(0, 10).map((b) => (
          <Batch key={b.batch_id} s={s} b={b} now={now} onOpenTerminal={onOpenTerminal} onChanged={onChanged} onUnauthorized={onUnauthorized} />
        ))}
      </ol>
    </section>
  );
}

const actionWords: Record<string, string> = {
  answer: "Answer",
  revisit: "Revisit",
  offer_accept: "Accept offer",
  offer_decline: "Decline offer",
  ship_ack: "Ran it",
  note: "Note",
  pause: "Pause",
};

function Batch({ s, b, now, onOpenTerminal, onChanged, onUnauthorized }: Omit<Props, "batches"> & { b: BatchView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = b.attempts.at(-1);
  const run = (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    op()
      .then(onChanged)
      .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : setError(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  };
  const acted = b.actions.filter((a) => a.acted).length;
  const queued = b.status === "queued";
  const btn = "btn btn-sm";
  return (
    <li className={`surface px-3.5 py-2.5 text-[13px] ${b.status === "cancelled" ? "opacity-60" : ""}`} data-batch={b.batch_id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-white">{b.kind === "pause" ? "Pause" : `${b.actions.length} action${b.actions.length === 1 ? "" : "s"}`}</span>
        <span className="chip" data-state={statusTone[b.status]}>
          <span className="lamp !h-1.5 !w-1.5 !animate-none !shadow-none" data-state={statusTone[b.status]} />
          <span className="sig-text">{statusLabel[b.status]}</span>
        </span>
        {last?.outcome === "transport_sent" && b.status !== "cancelled" ? <span className="text-[12px] text-ink-3">{routeLabel[last.route]}</span> : null}
        {b.kind === "send" && (b.status === "acted" || acted > 0) ? <span className="text-[12px] text-ink-3 tabular-nums">{`${acted}/${b.actions.length} acted`}</span> : null}
        {!b.current_run ? <span className="chip">earlier run</span> : null}
        <span className="flex-1" />
        <span className="text-[12px] text-ink-3">{relTime(b.created_at, now)}</span>
      </div>
      {b.cancelled ? <p className="mt-1 text-ink-3">{b.cancelled.by === "auto" ? `Not needed: ${b.cancelled.reason}.` : `Cancelled: ${b.cancelled.reason}.`}</p> : null}
      {b.warning ? <p className="mt-1.5 rounded-md bg-warn-bg px-2.5 py-1.5">{b.warning}</p> : null}
      {b.kind === "send" && acted > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-[12px]">
          {b.actions.map((a) =>
            a.acted ? (
              <li key={a.action_id} className={a.acted.outcome !== "applied" ? "rounded-md bg-warn-bg px-2 py-1" : "text-ink-3"}>
                {`${actionWords[a.type] ?? a.type}${a.item_id ? ` (${a.item_id})` : ""}: ${a.acted.outcome}`}
                {a.acted.note ? <span className="block text-ink">{`Agent's note: ${a.acted.note}`}</span> : null}
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      {b.retryable || queued ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {b.retryable ? (
            <button type="button" disabled={busy} onClick={() => run(() => api.retryBatch(s.id, b.batch_id))} className={btn}>
              Retry delivery
            </button>
          ) : null}
          {queued && !b.current_run && b.kind === "send" ? (
            <button type="button" disabled={busy} onClick={() => run(() => api.retargetBatch(s.id, b.batch_id))} className={btn} title="Send it to the conversation's current run; stale answers are refused">
              Move to current run
            </button>
          ) : null}
          {queued ? (
            <button type="button" disabled={busy} onClick={() => run(() => api.cancelBatch(s.id, b.batch_id))} className={btn}>
              Cancel
            </button>
          ) : null}
          {b.retryable && onOpenTerminal ? (
            <button type="button" onClick={onOpenTerminal} className="btn-link text-[12.5px]">
              Check the terminal
            </button>
          ) : null}
          {b.retryable ? <span className="text-[12px] text-ink-3">Retry sends it again as a new attempt; the agent may receive it twice.</span> : null}
        </div>
      ) : null}
      {error ? <p className="mt-1.5 text-[var(--sig-block)]">{error}</p> : null}
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[12px] text-ink-3">Exact text</summary>
        <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-ground-2 px-2.5 py-2 font-mono text-[11.5px] text-ink-2">{b.text}</pre>
      </details>
    </li>
  );
}
