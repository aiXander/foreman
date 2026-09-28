import { useCallback, useEffect, useState } from "react";
import type { ActivityEntry, BatchView, SessionView, TrayView, WorkView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { clock, dateTime, describeActivity, modeLabel, relPath, relTime, sessionTitle, stateLabel, useNow } from "../format";
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
        <Lamp state={s.state} />
        <h1 className="text-[16px] font-semibold tracking-tight">{sessionTitle(s)}</h1>
        <span className="text-[13px]">
          {stateLabel[s.state]}
          {since ? <span className="text-ink-2">{`, ${since}`}</span> : null}
        </span>
        <span className="text-[12px] text-ink-2">{modeLabel[s.mode]}</span>
        <span className="flex-1" />
        {hasTerminal ? (
          <div className="flex rounded-md border border-line p-0.5 text-[13px]" role="group" aria-label="View">
            {(["visual", "terminal"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded px-2.5 py-0.5 ${mode === m ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {m === "visual" ? "Card" : "Terminal"}
              </button>
            ))}
          </div>
        ) : s.mode === "observed" ? (
          <span className="text-[12px] text-ink-2">External terminal</span>
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
    <div className="grid gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="min-w-0">
        <section className="strip rounded-md bg-panel px-4 py-3" data-state={s.state}>
          <p className="text-[15px]">
            {s.current_tool ? `Running ${s.current_tool}` : stateLabel[s.state]}
            {s.subagents_active > 0 ? (
              <span className="text-ink-2">{`, ${s.subagents_active} subagent${s.subagents_active === 1 ? "" : "s"} active`}</span>
            ) : null}
          </p>
          {s.last_event_at ? <p className="text-[13px] text-ink-2">{`Last activity ${relTime(s.last_event_at, now)}`}</p> : null}
          {s.failure_streak >= 3 ? (
            <p className="mt-2 rounded bg-warn-bg px-2 py-1 text-[13px]">{`${s.failure_streak} consecutive tool failures`}</p>
          ) : null}
          {s.capabilities.cards ? (
            <p className="mt-2 text-[13px] text-ink-2">
              {`${s.tool_calls} tool call${s.tool_calls === 1 ? "" : "s"}`}
              {s.tool_failures > 0 ? `, ${s.tool_failures} failed` : ""}
            </p>
          ) : null}
          <p className="mt-2 text-[13px] text-ink-2">{s.capabilities.label}</p>
          <Controls s={s} now={now} onOpenTerminal={onOpenTerminal ?? (() => {})} onUnauthorized={onUnauthorized} />
        </section>

        {work ? <Brief w={work} now={now} /> : null}
        {work ? <Items session={s.id} items={work.items} t={t} now={now} reload={reload} onUnauthorized={onUnauthorized} /> : null}
        {work ? <Handover w={work} now={now} /> : null}

        {s.recent_paths.length > 0 ? (
          <section className="mt-5">
            <h2 className="mb-1.5 text-[13px] font-semibold text-ink-2">Recently touched files</h2>
            <ul className="space-y-0.5">
              {s.recent_paths.map((p) => (
                <li key={p} className="truncate" title={p}>
                  <Mono>{relPath(p, s.project)}</Mono>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-5">
          <h2 className="mb-1.5 text-[13px] font-semibold text-ink-2">Details</h2>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-1 text-[13px]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-2">{k}</dt>
                <dd className="min-w-0 break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      {s.id.startsWith("reg-") ? null : (
        <section className="min-w-0">
          {steerable ? <Tray session={s.id} t={t} reload={reload} onUnauthorized={onUnauthorized} /> : null}
          <Deliveries s={s} batches={batches} now={now} onOpenTerminal={onOpenTerminal} onChanged={reload} onUnauthorized={onUnauthorized} />
          <h2 className="mt-5 mb-1.5 text-[13px] font-semibold text-ink-2">Activity</h2>
          {activityError ? <p className="text-[13px] text-[var(--sig-block)]">{`Couldn't load activity: ${activityError}`}</p> : null}
          {activity && activity.length === 0 ? <p className="text-[13px] text-ink-2">Nothing recorded yet.</p> : null}
          {activity && activity.length > 0 ? (
            <ol className="space-y-1 text-[13px]">
              {[...activity].reverse().map((a) => {
                const [what, extra] = describeActivity(a);
                return (
                <li key={a.seq} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
                  <span className="text-ink-2 tabular-nums">{clock(a.ts)}</span>
                  <span className="min-w-0">
                    <span>{what}</span>
                    {a.tool ? <span className="text-ink-2">{` ${a.tool}`}</span> : null}
                    {extra ? <span className="text-ink-2">{`, ${extra}`}</span> : null}
                    {a.paths.length > 0 ? (
                      <span className="block truncate">
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
  return <span className="font-mono text-[12.5px]">{children}</span>;
}
