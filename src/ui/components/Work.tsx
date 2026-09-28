// The agent's declared work on the card (plan §11): goal and done-when, its own progress estimate
// (bar, ETA, confidence, now-line, checklist — never computed from the checklist, D7), and the
// handover review package. All agent text is rendered as plain text.
import type { WorkView } from "../../shared/api";
import { relTime } from "../format";

/** No declared update for this long reads as quiet (not stalled). */
const QUIET_MS = 20 * 60_000;

export function Brief({ w, now }: { w: WorkView; now: number }) {
  const b = w.brief;
  const p = w.progress;
  if (!b && !p) return <p className="mt-5 text-[13px] text-ink-2">The agent hasn't declared a brief yet.</p>;
  const checked = new Set(p?.checked ?? []);
  const quiet = p && now - Date.parse(p.at) > QUIET_MS;
  return (
    <section className="mt-5" aria-label="Brief and progress">
      {b ? (
        <>
          <h2 className="text-[15px] font-semibold">{b.goal}</h2>
          <p className="text-[13px]">
            <span className="text-ink-2">Done when: </span>
            {b.done_when}
          </p>
          {b.source ? <p className="truncate font-mono text-[12px] text-ink-2" title={b.source}>{b.source}</p> : null}
          {b.revision > 1 ? <p className="text-[12px] text-ink-2">{`Replanned ${b.revision - 1}×, last ${relTime(b.at, now)}`}</p> : null}
        </>
      ) : null}
      {p ? (
        <div className="mt-2">
          <div className="flex items-baseline gap-2 text-[13px]">
            <span className="font-semibold tabular-nums">{`${p.progress}%`}</span>
            <span className="text-ink-2">{`estimated, ${p.confidence} confidence`}</span>
            {p.eta_min ? <span className="text-ink-2">{`· ${eta(p.eta_min)} left`}</span> : null}
            {p.phase ? <span className="text-ink-2">{`· ${p.phase}`}</span> : null}
            <span className="flex-1" />
            <span className={quiet ? "text-[var(--sig-wait)]" : "text-ink-2"}>{`updated ${relTime(p.at, now)}`}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-panel-2" role="progressbar" aria-valuenow={p.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full ${p.confidence === "low" ? "bg-ink-2" : "bg-accent"}`} style={{ width: `${p.progress}%` }} />
          </div>
          <p className="mt-1 text-[13px]">
            <span className="text-ink-2">Now: </span>
            {p.now}
          </p>
          {quiet ? <p className="text-[12px] text-ink-2">No declared update for over 20 minutes (that alone doesn't mean it's stuck).</p> : null}
        </div>
      ) : null}
      {b?.checklist.length ? (
        <ul className="mt-2 space-y-0.5 text-[13px]">
          {b.checklist.map((c) => (
            <li key={c.id} className={checked.has(c.id) ? "text-ink-2 line-through" : ""}>
              <span aria-hidden className="mr-1.5 inline-block w-3">{checked.has(c.id) ? "✓" : "○"}</span>
              {c.label}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function eta([lo, hi]: number[]): string {
  const f = (m: number) => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);
  return lo === hi ? f(lo!) : `${f(lo!)}–${f(hi!)}`;
}

export function Handover({ w, now }: { w: WorkView; now: number }) {
  const h = w.handover;
  if (!h) return null;
  return (
    <section className="mt-5 rounded-md border border-line bg-panel px-3 py-2.5 text-[13px]" aria-label="Handover">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-ink-2">Handover</h2>
        <span className="flex-1" />
        <span className="text-ink-2">{relTime(h.at, now)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">{h.summary_md}</p>
      <List title="What changed" items={h.what_changed} />
      <List title="How to verify" items={h.how_to_verify} />
      {h.evidence.length ? (
        <div className="mt-2">
          <h3 className="text-[12px] font-semibold text-ink-2">Evidence</h3>
          <ul className="space-y-0.5">
            {h.evidence.map((e) => (
              <li key={e.label + e.ref} className="break-words">
                {e.label}: <span className="font-mono text-[12px]">{e.ref}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <List title="Docs touched" items={h.docs_touched} mono />
      {h.open_items_carried.length ? <p className="mt-2 text-ink-2">{`Still open: ${h.open_items_carried.join(", ")}`}</p> : null}
      {h.next_prompt ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-ink-2">Prompt for whoever continues</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px]">{h.next_prompt}</pre>
        </details>
      ) : null}
    </section>
  );
}

function List({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <h3 className="text-[12px] font-semibold text-ink-2">{title}</h3>
      <ul className={`list-disc space-y-0.5 pl-4 ${mono ? "font-mono text-[12px]" : ""}`}>
        {items.map((x) => (
          <li key={x} className="break-words">
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}
