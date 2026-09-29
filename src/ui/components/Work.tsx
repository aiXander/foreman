// The agent's declared work on the card (plan §11): goal and done-when, its own progress estimate
// (bar, ETA, confidence, now-line, checklist — never computed from the checklist, D7), and the
// handover review package. The handover summary goes through the safe Markdown subset
// (Markdown.tsx); every other agent field is plain text.
import type { WorkView } from "../../shared/api";
import { relTime } from "../format";
import { Markdown } from "./Markdown";

/** No declared update for this long reads as quiet (not stalled). */
const QUIET_MS = 20 * 60_000;

export function Brief({ w, now }: { w: WorkView; now: number }) {
  const b = w.brief;
  const p = w.progress;
  if (!b && !p) return <p className="mt-7 text-[13px] text-ink-3">The agent hasn't declared a brief yet.</p>;
  const checked = new Set(p?.checked ?? []);
  const quiet = p && now - Date.parse(p.at) > QUIET_MS;
  return (
    <section className="mt-7" aria-label="Brief and progress">
      {b ? (
        <>
          <h2 className="eyebrow mb-2">Brief</h2>
          <p className="text-[18px] leading-snug font-semibold tracking-tight text-white">{b.goal}</p>
          <p className="mt-1.5 text-[13px] text-ink-2">
            <span className="text-ink-3">Done when </span>
            {b.done_when}
          </p>
          {b.source ? <p className="mt-1 truncate font-mono text-[11.5px] text-ink-3" title={b.source}>{b.source}</p> : null}
          {b.revision > 1 ? <p className="mt-0.5 text-[12px] text-ink-3">{`Replanned ${b.revision - 1}×, last ${relTime(b.at, now)}`}</p> : null}
        </>
      ) : null}
      {p ? (
        <div className="surface mt-4 px-4 py-3.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
            <span className="text-[22px] leading-none font-semibold tracking-tight text-white tabular-nums">{`${p.progress}%`}</span>
            <span className="text-ink-3">{`estimated, ${p.confidence} confidence`}</span>
            {p.eta_min ? <span className="text-ink-3">{`· ${eta(p.eta_min)} left`}</span> : null}
            {p.phase ? <span className="text-ink-3">{`· ${p.phase}`}</span> : null}
            <span className="flex-1" />
            <span className={`text-[12px] ${quiet ? "text-[var(--sig-wait)]" : "text-ink-3"}`}>{`updated ${relTime(p.at, now)}`}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ground-2 shadow-[inset_0_0_0_1px_var(--line)]" role="progressbar" aria-valuenow={p.progress} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`h-full rounded-full transition-[width] duration-700 ease-out ${
                p.confidence === "low" ? "bg-ink-3" : "bg-gradient-to-r from-[#7f8cff] to-accent shadow-[0_0_12px_rgb(165_151_255/0.6)]"
              }`}
              style={{ width: `${p.progress}%` }}
            />
          </div>
          <p className="mt-3 text-[13px] text-ink">
            <span className="text-ink-3">Now </span>
            {p.now}
          </p>
          {quiet ? <p className="mt-1 text-[12px] text-ink-3">No declared update for over 20 minutes (that alone doesn't mean it's stuck).</p> : null}
        </div>
      ) : null}
      {b?.checklist.length ? (
        <ul className="mt-3 space-y-1 text-[13px]">
          {b.checklist.map((c) => {
            const done = checked.has(c.id);
            return (
              <li key={c.id} className={`flex items-start gap-2.5 ${done ? "text-ink-3 line-through decoration-ink-3/60" : "text-ink"}`}>
                <span
                  aria-hidden
                  className={`mt-[3px] grid h-3.5 w-3.5 flex-none place-items-center rounded-full text-[9px] leading-none no-underline ${
                    done ? "bg-[var(--sig-work)] font-bold text-ground" : "border border-line-3"
                  }`}
                >
                  {done ? "✓" : ""}
                </span>
                {c.label}
              </li>
            );
          })}
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
    <section className="strip mt-7 px-4 py-3.5 text-[13px]" data-state="working" aria-label="Handover">
      <div className="flex items-baseline gap-2">
        <h2 className="eyebrow !text-[var(--sig-work)]">Handover</h2>
        <span className="flex-1" />
        <span className="text-[12px] text-ink-3">{relTime(h.at, now)}</span>
      </div>
      <Markdown text={h.summary_md} className="mt-2 text-ink" />
      <List title="What changed" items={h.what_changed} />
      <List title="How to verify" items={h.how_to_verify} />
      {h.evidence.length ? (
        <div className="mt-3">
          <h3 className="eyebrow mb-1">Evidence</h3>
          <ul className="space-y-0.5 text-ink-2">
            {h.evidence.map((e) => (
              <li key={e.label + e.ref} className="break-words">
                {e.label}: <span className="font-mono text-[12px] text-ink">{e.ref}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <List title="Docs touched" items={h.docs_touched} mono />
      {h.open_items_carried.length ? <p className="mt-3 text-ink-3">{`Still open: ${h.open_items_carried.join(", ")}`}</p> : null}
      {h.next_prompt ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] text-ink-3">Prompt for whoever continues</summary>
          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-ground-2 px-2.5 py-2 font-mono text-[11.5px] text-ink-2">{h.next_prompt}</pre>
        </details>
      ) : null}
    </section>
  );
}

function List({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <h3 className="eyebrow mb-1">{title}</h3>
      <ul className={`list-disc space-y-0.5 pl-4 text-ink-2 marker:text-ink-3 ${mono ? "font-mono text-[12px]" : ""}`}>
        {items.map((x) => (
          <li key={x} className="break-words">
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}
