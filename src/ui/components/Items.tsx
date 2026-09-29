// What the agent put on the card (plan §11): needs-you items (questions, blockers, offers, ships,
// unfixed issues), decisions to review, then deliverables/notes and closed items. Every answer,
// accept or revisit click stages into the send tray; only "Mark reviewed" acts at once (it is a
// local review that never steers the agent). Agent summaries/details go through the safe Markdown
// subset (Markdown.tsx: text nodes only, http(s) links only); every other agent field is plain text.
import { useState } from "react";
import type { WorkView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { relTime } from "../format";
import { InlineMarkdown, Markdown } from "./Markdown";
import type { TrayApi } from "./Tray";

type Item = WorkView["items"][number];

const kindLabel: Record<Item["body"]["kind"], string> = {
  question: "Question",
  blocker: "Blocker",
  issue: "Issue",
  offer: "Offer",
  ship: "Ready to ship",
  decision: "Decision",
  deliverable: "Deliverable",
  note: "Note",
};

/** Which signal colour each kind's label borrows (via the lamp's data-state palette). */
const kindTone: Record<Item["body"]["kind"], string> = {
  question: "waiting_input",
  blocker: "waiting_permission",
  issue: "waiting_input",
  offer: "starting",
  ship: "working",
  decision: "starting",
  deliverable: "working",
  note: "idle",
};

const btn = "btn btn-sm";
const btnOn = "btn btn-sm btn-on";

export function Items({ session, items, t, now, reload, onUnauthorized }: { session: string; items: Item[]; t: TrayApi; now: number; reload: () => void; onUnauthorized: () => void }) {
  const needs = items.filter((i) => i.actionable && i.body.kind !== "decision");
  const decisions = items.filter((i) => i.body.kind === "decision" && !i.resolved);
  const other = items.filter((i) => !i.resolved && !i.actionable && i.body.kind !== "decision");
  const closed = items.filter((i) => i.resolved);
  return (
    <>
      {needs.length > 0 ? (
        <section className="mt-7">
          <h2 className="eyebrow mb-2.5 !text-[var(--sig-wait)]">{`Needs you (${needs.length})`}</h2>
          <ol className="space-y-2">
            {needs.map((i) => (
              <ItemCard key={i.id} i={i} t={t} now={now} session={session} reload={reload} onUnauthorized={onUnauthorized} />
            ))}
          </ol>
        </section>
      ) : null}
      {decisions.length > 0 ? (
        <section className="mt-7">
          <h2 className="eyebrow mb-2.5">{`Decisions (${decisions.filter((d) => d.actionable).length} to review)`}</h2>
          <ol className="space-y-2">
            {decisions.map((i) => (
              <ItemCard key={i.id} i={i} t={t} now={now} session={session} reload={reload} onUnauthorized={onUnauthorized} />
            ))}
          </ol>
        </section>
      ) : null}
      {other.length > 0 ? (
        <section className="mt-7">
          <h2 className="eyebrow mb-2.5">Deliverables and notes</h2>
          <ol className="space-y-2">
            {other.map((i) => (
              <ItemCard key={i.id} i={i} t={t} now={now} session={session} reload={reload} onUnauthorized={onUnauthorized} />
            ))}
          </ol>
        </section>
      ) : null}
      {closed.length > 0 ? (
        <details className="mt-7">
          <summary className="eyebrow cursor-pointer">{`Closed (${closed.length})`}</summary>
          <ol className="mt-2.5 space-y-2">
            {closed.map((i) => (
              <ItemCard key={i.id} i={i} t={t} now={now} session={session} reload={reload} onUnauthorized={onUnauthorized} />
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

function ItemCard({ i, t, now, session, reload, onUnauthorized }: { i: Item; t: TrayApi; now: number; session: string; reload: () => void; onUnauthorized: () => void }) {
  const b = i.body;
  const staged = t.staged(i.id);
  const open = !i.resolved;
  return (
    <li
      className={`surface px-4 py-3 text-[13px] ${i.actionable ? "shadow-[inset_2px_0_0_var(--sig),0_8px_24px_-16px_rgb(0_0_0/0.8)]" : i.resolved ? "opacity-60" : ""}`}
      data-item={i.id}
      data-state={kindTone[b.kind]}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="sig-text text-[10.5px] font-semibold uppercase tracking-[0.08em]">{kindLabel[b.kind]}</span>
        <span className="font-medium text-white">{i.title}</span>
        {i.impact === "high" ? <span className="chip h-[18px] border-[rgb(255_194_74/0.3)] bg-warn-bg px-1.5 text-[10.5px] text-[#ffe2a3]">high impact</span> : null}
        {i.reversibility === "one-way" ? <span className="chip h-[18px] border-[rgb(255_194_74/0.3)] bg-warn-bg px-1.5 text-[10.5px] text-[#ffe2a3]">one-way</span> : null}
        <span className="flex-1" />
        <span className="text-[12px] text-ink-3">{relTime(i.updated_at, now)}</span>
      </div>
      <p className="mt-1 break-words text-ink-2">
        <InlineMarkdown text={i.summary} />
      </p>
      <Body i={i} />
      {i.detail ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[12px] text-ink-3">Detail</summary>
          <Markdown text={i.detail} className="mt-1.5 text-ink-2" />
        </details>
      ) : null}
      {i.refs?.length ? (
        <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px] text-ink-3">
          {i.refs.map((r) => (
            <li key={r} className="truncate" title={r}>
              {r}
            </li>
          ))}
        </ul>
      ) : null}
      {i.resolved ? <p className="mt-1.5 text-[12px] text-ink-3">{`Closed: ${i.resolved.outcome.replace("_", " ")}${i.resolved.reason ? `, ${i.resolved.reason}` : ""}.`}</p> : null}
      {open ? <Actions i={i} t={t} staged={staged} session={session} reload={reload} onUnauthorized={onUnauthorized} /> : null}
      <Receipts i={i} />
    </li>
  );
}

function Body({ i }: { i: Item }) {
  const b = i.body;
  switch (b.kind) {
    case "question": {
      const def = b.options.find((o) => o.id === b.default);
      const policy =
        b.policy === "proceed"
          ? `The agent is continuing with "${def?.label}" unless you answer.`
          : b.policy === "park"
            ? `The agent is doing other work first; it recommends "${def?.label}".`
            : `Blocking: the agent has stopped and waits for your answer (it recommends "${def?.label}").`;
      return <p className={`mt-1.5 text-[12.5px] ${b.policy === "block" ? "font-medium text-[#ffe2a3]" : "text-ink-3"}`}>{policy}</p>;
    }
    case "blocker":
      return (
        <p className="mt-1">
          <span className="text-ink-2">Needs: </span>
          {b.need}
          {b.tried.length ? <span className="block text-ink-2">{`Tried: ${b.tried.join("; ")}`}</span> : null}
        </p>
      );
    case "issue":
      return <p className="mt-1 text-ink-2">{`Severity ${b.severity}; ${b.handled}.`}</p>;
    case "offer":
      return <p className="mt-1">{`${b.value} (cost: ${b.cost}; default: ${b.default === "do" ? "do it" : "skip it"})`}</p>;
    case "ship":
      return (
        <div className="mt-1">
          <p>{`${b.what}. ${b.why_now}`}</p>
          <pre className="mt-1.5 overflow-x-auto rounded-md border border-line bg-ground-2 px-2.5 py-1.5 font-mono text-[12px] text-[var(--sig-work)]">
            <span className="text-ink-3 select-none">$ </span>
            {b.command}
          </pre>
          <p className="mt-1 text-[12px] text-ink-3">Foreman never runs this; acknowledge after you ran it yourself.</p>
        </div>
      );
    case "decision":
      return (
        <p className="mt-1">
          <span className="text-ink-2">Chose: </span>
          {b.chose}
          {b.alternatives.length ? <span className="text-ink-2">{` (over ${b.alternatives.join(", ")})`}</span> : null}
          <span className="block text-ink-2">{b.why}</span>
        </p>
      );
    case "deliverable":
      return <p className="mt-1 break-all font-mono text-[12px]">{`${b.type}: ${b.ref}`}</p>;
    case "note":
      return null;
  }
}

/** Stage clicks. Clicking a staged choice again takes it back out of the tray. */
function Actions({ i, t, staged, session, reload, onUnauthorized }: { i: Item; t: TrayApi; staged: ReturnType<TrayApi["staged"]>; session: string; reload: () => void; onUnauthorized: () => void }) {
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const b = i.body;
  const ref = { item_id: i.id, item_revision: i.revision };
  const toggle = (on: boolean, stage: () => void) => (on && staged ? t.unstage(staged.action_id) : stage());
  const withText = (label: string, type: "answer" | "revisit") => (
    <div className="mt-2 flex gap-1.5">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        placeholder={label}
        aria-label={label}
        className="field min-w-0 flex-1 py-1 text-[13px]"
      />
      <button
        type="button"
        disabled={t.busy || !text.trim()}
        onClick={() => {
          t.stage(type === "answer" ? { type, ...ref, text: text.trim() } : { type, ...ref, text: text.trim() });
          setText("");
        }}
        className={btn}
      >
        Stage
      </button>
    </div>
  );
  const stagedNote = staged ? (
    <p className="mt-2 flex items-center gap-1.5 text-[12px] text-accent">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
      {`In the send tray: ${describeStaged(staged, i)}`}
    </p>
  ) : null;

  switch (b.kind) {
    case "question":
      return (
        <div className="mt-2.5">
          <div className="flex flex-wrap gap-1.5">
            {b.options.map((o) => {
              const on = staged?.type === "answer" && staged.option_id === o.id && !staged.text;
              return (
                <button key={o.id} type="button" disabled={t.busy} className={on ? btnOn : btn} title={o.consequence} aria-pressed={on} onClick={() => toggle(on, () => t.stage({ type: "answer", ...ref, option_id: o.id }))}>
                  {o.label}
                  {o.id === b.default ? <span className="font-normal opacity-70"> (default)</span> : null}
                </button>
              );
            })}
          </div>
          {withText("Or answer in your own words", "answer")}
          {stagedNote}
        </div>
      );
    case "blocker":
      return (
        <div className="mt-1.5">
          {withText("Your answer", "answer")}
          {stagedNote}
        </div>
      );
    case "issue":
      return (
        <div className="mt-1.5">
          {withText("Ask the agent to revisit this", "revisit")}
          {stagedNote}
        </div>
      );
    case "offer": {
      const acc = staged?.type === "offer_accept";
      const dec = staged?.type === "offer_decline";
      return (
        <div className="mt-2.5 flex gap-1.5">
          <button type="button" disabled={t.busy} className={acc ? btnOn : btn} aria-pressed={acc} onClick={() => toggle(acc, () => t.stage({ type: "offer_accept", ...ref }))}>
            Accept
          </button>
          <button type="button" disabled={t.busy} className={dec ? btnOn : btn} aria-pressed={dec} onClick={() => toggle(dec, () => t.stage({ type: "offer_decline", ...ref }))}>
            Decline
          </button>
        </div>
      );
    }
    case "ship": {
      const on = staged?.type === "ship_ack";
      return (
        <div className="mt-2.5">
          <button type="button" disabled={t.busy} className={on ? btnOn : btn} aria-pressed={on} onClick={() => toggle(on, () => t.stage({ type: "ship_ack", ...ref }))}>
            I ran it
          </button>
        </div>
      );
    }
    case "decision": {
      const review = () => {
        setReviewing(true);
        setErr(null);
        api
          .markReviewed(session, i.id, i.revision)
          .then(reload)
          .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : setErr(e instanceof Error ? e.message : String(e))))
          .finally(() => setReviewing(false));
      };
      return (
        <div className="mt-2.5">
          {i.actionable ? (
            <button type="button" disabled={reviewing} onClick={review} className={btn} title="A local review: the agent is not told.">
              Mark reviewed
            </button>
          ) : (
            <p className="text-[12px] text-ink-3">{`Reviewed (revision ${i.reviewed_revision}).`}</p>
          )}
          {withText("Revisit: what should change?", "revisit")}
          {stagedNote}
          {err ? <p className="mt-1 text-[var(--sig-block)]">{err}</p> : null}
        </div>
      );
    }
    default:
      return null;
  }
}

function describeStaged(a: NonNullable<ReturnType<TrayApi["staged"]>>, i: Item): string {
  switch (a.type) {
    case "answer": {
      const opt = i.body.kind === "question" && a.option_id ? i.body.options.find((o) => o.id === a.option_id)?.label : null;
      return [opt, a.text].filter(Boolean).join(" — ");
    }
    case "revisit":
      return `revisit: ${a.text}`;
    case "offer_accept":
      return "accept";
    case "offer_decline":
      return "decline";
    case "ship_ack":
      return "I ran it";
    default:
      return a.type;
  }
}

const outcomeWords = { applied: "applied", declined: "declined", blocked: "blocked" } as const;

/** What the human already sent about this item and how the agent answered (incl. declined/blocked notes). */
function Receipts({ i }: { i: Item }) {
  if (!i.human.length) return null;
  return (
    <ul className="mt-2.5 space-y-1 border-t border-line/70 pt-2 text-[12px] text-ink-2">
      {i.human.map((h) => {
        const opt = i.body.kind === "question" && h.option_id ? (i.body.options.find((o) => o.id === h.option_id)?.label ?? h.option_id) : h.option_id;
        const what = h.type === "answer" ? `You answered ${[opt, h.text].filter(Boolean).join(" — ")}` : h.type === "revisit" ? `You asked to revisit: ${h.text}` : h.type === "offer_accept" ? "You accepted" : h.type === "offer_decline" ? "You declined" : "You said you ran it";
        return (
          <li key={h.action_id} className={h.outcome && h.outcome !== "applied" ? "rounded-md bg-warn-bg px-2 py-1" : ""}>
            <span>{what}</span>
            <span className="text-ink-3">{h.outcome ? ` → agent: ${outcomeWords[h.outcome]}` : " → no reply from the agent yet"}</span>
            {h.note ? <span className="block">{`Agent's note: ${h.note}`}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
