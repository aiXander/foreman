import { useCallback, useEffect, useState } from "react";
import type { ActivityEntry, BatchView, SessionView, TrayView, WorkView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { basename, clock, dateTime, describeActivity, modeLabel, relPath, relTime, sessionTitle, stateLabel, useNow } from "../format";
import { Controls } from "./Controls";
import { Deliveries } from "./Deliveries";
import { Items } from "./Items";
import { Tray, useTray } from "./Tray";
import { Brief, Handover } from "./Work";
import { Lamp } from "./Lamp";
import { TerminalPane } from "./TerminalPane";

export type ViewMode = "visual" | "terminal";

export function SessionPage({
  s,
  mode,
  setMode,
  onUnauthorized,
}: {
  s: SessionView;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  onUnauthorized: () => void;
}) {
  const now = useNow();
  const hasTerminal = s.mode === "managed" && s.terminal_id !== null;
  const showTerminal = hasTerminal && mode === "terminal";
  const since = relTime(s.state_since, now);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ground-2/60 px-6 py-3 backdrop-blur-xl">
        <Lamp state={s.state} />
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink-3" title={s.project}>
            {basename(s.project)}
          </p>
          <h1 className="truncate text-[17px] leading-tight font-semibold tracking-tight text-white">{sessionTitle(s)}</h1>
        </div>
        <span className="chip h-6 px-2.5 text-[12px]" data-state={s.state}>
          <span className="sig-text font-medium">{stateLabel[s.state]}</span>
          {since ? <span className="text-ink-3">{since}</span> : null}
        </span>
        <span className="chip">{modeLabel[s.mode]}</span>
        <span className="flex-1" />
        {hasTerminal ? (
          <div className="seg" role="group" aria-label="View">
            {(["visual", "terminal"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "visual" ? "Card" : "Terminal"}
              </button>
            ))}
          </div>
        ) : s.mode === "observed" ? (
          <span className="text-[12px] text-ink-3">External terminal</span>
        ) : null}
      </header>
      {showTerminal ? (
        <div className="min-h-0 flex-1">
          <TerminalPane terminalId={s.terminal_id!} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Card s={s} now={now} onOpenTerminal={hasTerminal ? () => setMode("terminal") : null} onUnauthorized={onUnauthorized} />
        </div>
      )}
    </div>
  );
}

function Card({ s, now, onOpenTerminal, onUnauthorized }: { s: SessionView; now: number; onOpenTerminal: (() => void) | null; onUnauthorized: () => void }) {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [batches, setBatches] = useState<BatchView[]>([]);
  const [work, setWork] = useState<WorkView | null>(null);
  const [tray, setTray] = useState<TrayView | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Refetch whenever the journal advances, the delivery summary changes (orphan/unseen are
  // time-based) or the tray changes elsewhere (another tab).
  const deliveryKey = JSON.stringify(s.delivery);
  useEffect(() => {
    if (s.id.startsWith("reg-")) return;
    let cancelled = false;
    api
      .session(s.id)
      .then((r) => {
        if (!cancelled) {
          setActivity(r.activity);
          setBatches(r.batches);
          setWork(r.work);
          setTray(r.tray);
          setActivityError(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof Unauthorized) onUnauthorized();
        else setActivityError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [s.id, s.last_seq, deliveryKey, s.unsent, tick, onUnauthorized]);

  const t = useTray(s.id, tray, setTray, reload, onUnauthorized);
  const steerable = s.capabilities.cards && !s.id.startsWith("reg-");

  const rows: [string, React.ReactNode][] = [];
  if (s.model) rows.push(["Model", s.model]);
  rows.push(["Working directory", <Mono key="cwd">{s.cwd}</Mono>]);
  if (s.project !== s.cwd) rows.push(["Project", <Mono key="p">{s.project}</Mono>]);
  rows.push(["Process", s.process === "alive" ? "Running" : s.process === "dead" ? "Not running" : "Unknown"]);
  if (s.started_at) rows.push(["Run started", dateTime(s.started_at)]);
  if (s.ended_at) rows.push(["Run ended", `${dateTime(s.ended_at)}${s.end_reason ? `, ${s.end_reason}` : ""}`]);
  if (s.terminal_state) rows.push(["Terminal", s.terminal_state === "live" ? "Live" : "Exited"]);
  rows.push(["Claude session", <Mono key="n">{s.native_id}</Mono>]);

  return (
    <div className="enter grid gap-6 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
      <div className="min-w-0">
        <section className="strip px-5 py-4" data-state={s.state}>
          <p className="text-[17px] font-medium tracking-tight text-white">
            {s.current_tool ? (
              <>
                <span className="text-ink-2">Running </span>
                <span className="font-mono text-[15px]">{s.current_tool}</span>
              </>
            ) : (
              <span className="sig-text">{stateLabel[s.state]}</span>
            )}
            {s.subagents_active > 0 ? (
              <span className="text-[14px] font-normal text-ink-2">{`, ${s.subagents_active} subagent${s.subagents_active === 1 ? "" : "s"} active`}</span>
            ) : null}
          </p>
          {s.last_event_at ? <p className="mt-0.5 text-[12.5px] text-ink-3">{`Last activity ${relTime(s.last_event_at, now)}`}</p> : null}
          {s.failure_streak >= 3 ? (
            <p className="mt-3 rounded-md bg-warn-bg px-2.5 py-1.5 text-[13px]">{`${s.failure_streak} consecutive tool failures`}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
            {s.capabilities.cards ? (
              <span className="chip h-6 px-2.5 text-[12px]">
                <span className="font-semibold text-ink tabular-nums">{s.tool_calls}</span>
                {`tool call${s.tool_calls === 1 ? "" : "s"}`}
                {s.tool_failures > 0 ? <span className="text-[var(--sig-block)]">{`· ${s.tool_failures} failed`}</span> : null}
              </span>
            ) : null}
            <span className="text-ink-3">{s.capabilities.label}</span>
          </div>
          <Controls s={s} now={now} onOpenTerminal={onOpenTerminal ?? (() => {})} onUnauthorized={onUnauthorized} />
        </section>

        {work ? <Brief w={work} now={now} /> : null}
        {work ? <Items session={s.id} items={work.items} t={t} now={now} reload={reload} onUnauthorized={onUnauthorized} /> : null}
        {work ? <Handover w={work} now={now} /> : null}

        {s.recent_paths.length > 0 ? (
          <section className="mt-7">
            <h2 className="eyebrow mb-2">Recently touched files</h2>
            <ul className="surface divide-y divide-line/70 overflow-hidden">
              {s.recent_paths.map((p) => (
                <li key={p} className="truncate px-3.5 py-1.5 text-ink-2 hover:bg-panel-2 hover:text-ink" title={p}>
                  <Mono>{relPath(p, s.project)}</Mono>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-7">
          <h2 className="eyebrow mb-2">Details</h2>
          <dl className="surface grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 px-4 py-3.5 text-[13px]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3">{k}</dt>
                <dd className="min-w-0 break-words text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      {s.id.startsWith("reg-") ? null : (
        <section className="min-w-0">
          {steerable ? <Tray session={s.id} t={t} reload={reload} onUnauthorized={onUnauthorized} /> : null}
          <Deliveries s={s} batches={batches} now={now} onOpenTerminal={onOpenTerminal} onChanged={reload} onUnauthorized={onUnauthorized} />
          <h2 className="eyebrow mt-7 mb-2.5">Activity</h2>
          {activityError ? <p className="text-[13px] text-[var(--sig-block)]">{`Couldn't load activity: ${activityError}`}</p> : null}
          {activity && activity.length === 0 ? <p className="text-[13px] text-ink-3">Nothing recorded yet.</p> : null}
          {activity && activity.length > 0 ? (
            <ol className="relative ml-1 border-l border-line-2 text-[13px]">
              {[...activity].reverse().map((a) => {
                const [what, extra] = describeActivity(a);
                return (
                <li key={a.seq} className="relative grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 py-1 pl-4">
                  <span aria-hidden className="absolute top-[11px] -left-[3.5px] h-[6px] w-[6px] rounded-full bg-line-2 ring-2 ring-ground" />
                  <span className="font-mono text-[11.5px] leading-[1.7] text-ink-3 tabular-nums">{clock(a.ts)}</span>
                  <span className="min-w-0">
                    <span className="text-ink">{what}</span>
                    {a.tool ? <span className="font-mono text-[12px] text-ink-2">{` ${a.tool}`}</span> : null}
                    {extra ? <span className="text-ink-3">{`, ${extra}`}</span> : null}
                    {a.paths.length > 0 ? (
                      <span className="block truncate text-ink-3">
                        <Mono>{a.paths.map((p) => relPath(p, s.project)).join(", ")}</Mono>
                      </span>
                    ) : null}
                  </span>
                </li>
                );
              })}
            </ol>
          ) : null}
        </section>
      )}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12px]">{children}</span>;
}
