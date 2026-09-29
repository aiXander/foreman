import type { ActivityState, SessionView } from "../../shared/api";
import { basename, modeLabel, relTime, sessionTitle, stateLabel, useNow } from "../format";
import { href } from "../route";
import { Lamp } from "./Lamp";
import { groupByProject, Logo, UnsentBadge } from "./Sidebar";

/** Header counters: which lamp colour stands for each bucket, and the states it counts. */
const buckets: { label: string; lamp: ActivityState; states: ActivityState[] }[] = [
  { label: "need you", lamp: "waiting_permission", states: ["waiting_permission", "waiting_input"] },
  { label: "working", lamp: "working", states: ["working", "starting", "finishing"] },
  { label: "idle", lamp: "idle", states: ["idle", "unknown"] },
  { label: "ended", lamp: "dead", states: ["dead"] },
];

export function Overview({ sessions, onOpenTerminal }: { sessions: SessionView[]; onOpenTerminal: (id: string) => void }) {
  const now = useNow();
  const groups = groupByProject(sessions);
  if (groups.length === 0) {
    return (
      <div className="enter mx-auto flex max-w-xl flex-col items-start px-6 py-24">
        <Logo size={40} />
        <h1 className="mt-6 text-[26px] font-semibold tracking-tight text-white">No sessions yet</h1>
        <p className="mt-2 text-[15px] text-ink-2">
          Launch a Claude session here, or run <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[13px] text-ink">foreman run claude</code> in a
          terminal. Sessions started elsewhere with the Foreman plugin loaded show up on their own.
        </p>
        <a href={href({ name: "launch" })} className="btn btn-primary mt-7 h-9 px-4 text-[14px]">
          Launch a session
        </a>
      </div>
    );
  }
  return (
    <div className="enter px-8 pt-7 pb-10">
      <header className="mb-7 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-white">Sessions</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">{`${sessions.length} across ${groups.length} project${groups.length === 1 ? "" : "s"}`}</p>
        </div>
        <span className="flex-1" />
        <div className="flex flex-wrap gap-2">
          {buckets.map((b) => {
            const n = sessions.filter((s) => b.states.includes(s.state)).length;
            return (
              <span key={b.label} className={`chip h-7 gap-2 px-3 text-[12px] ${n === 0 ? "opacity-45" : "text-ink"}`}>
                <Lamp state={b.lamp} title={b.label} />
                <span className="font-semibold tabular-nums">{n}</span>
                <span className="text-ink-2">{b.label}</span>
              </span>
            );
          })}
        </div>
      </header>
      {groups.map(([project, list]) => (
        <section key={project} className="mb-9">
          <h2 className="mb-3 flex items-baseline gap-3">
            <span className="text-[15px] font-semibold tracking-tight text-white">{basename(project)}</span>
            <span className="truncate font-mono text-[11.5px] text-ink-3">{project}</span>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {list.map((s) => (
              <SessionTile key={s.id} s={s} now={now} onOpenTerminal={onOpenTerminal} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SessionTile({ s, now, onOpenTerminal }: { s: SessionView; now: number; onOpenTerminal: (id: string) => void }) {
  const since = relTime(s.state_since, now);
  const canTerminal = s.mode === "managed" && s.terminal_id && s.terminal_state === "live";
  return (
    <article className={`strip tile relative px-4 pt-3 pb-3 ${s.state === "dead" ? "opacity-60 hover:opacity-90" : ""}`} data-state={s.state}>
      <a href={href({ name: "session", id: s.id })} className="absolute inset-0 rounded-[inherit]" aria-label={`Open ${sessionTitle(s)}`} />
      <div className="flex items-center gap-2.5">
        <Lamp state={s.state} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-white">{sessionTitle(s)}</span>
        {s.unsent > 0 ? <UnsentBadge n={s.unsent} /> : null}
        <span className="chip h-[18px] px-1.5 text-[10.5px]">{modeLabel[s.mode]}</span>
      </div>
      <p className="mt-1.5 text-[13px]">
        <span className="sig-text font-medium">{stateLabel[s.state]}</span>
        {since ? <span className="text-ink-3">{` · ${since}`}</span> : null}
      </p>
      {s.current_tool ? (
        <p className="mt-1 truncate font-mono text-[12px] text-ink-2">
          <span className="text-ink-3">▸ </span>
          {s.current_tool}
        </p>
      ) : null}
      {s.failure_streak >= 3 ? (
        <p className="mt-1.5 text-[12px] text-[var(--sig-wait)]">{`${s.failure_streak} consecutive tool failures`}</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2 border-t border-line/70 pt-2.5 text-[12px] text-ink-3">
        <span className="min-w-0 flex-1 truncate">{s.capabilities.label}</span>
        {canTerminal ? (
          <button type="button" onClick={() => onOpenTerminal(s.id)} className="btn btn-sm relative z-10">
            <span aria-hidden className="font-mono text-[11px] text-ink-3">{">_"}</span>
            Terminal
          </button>
        ) : s.mode === "observed" ? (
          <span>External terminal</span>
        ) : null}
      </div>
    </article>
  );
}
