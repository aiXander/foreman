import type { SessionView } from "../../shared/api";
import { basename, modeLabel, relTime, sessionTitle, stateLabel, useNow } from "../format";
import { href } from "../route";
import { Lamp } from "./Lamp";
import { groupByProject, UnsentBadge } from "./Sidebar";

export function Overview({ sessions, onOpenTerminal }: { sessions: SessionView[]; onOpenTerminal: (id: string) => void }) {
  const now = useNow();
  const groups = groupByProject(sessions);
  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-[20px] font-semibold tracking-tight">No sessions yet</h1>
        <p className="mt-2 text-ink-2">
          Launch a Claude session here, or run <code className="font-mono text-[13px]">foreman run claude</code> in a terminal. Sessions
          started elsewhere with the Foreman plugin loaded show up on their own.
        </p>
        <a href={href({ name: "launch" })} className="mt-5 inline-block rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink">
          Launch a session
        </a>
      </div>
    );
  }
  return (
    <div className="px-6 py-5">
      {groups.map(([project, list]) => (
        <section key={project} className="mb-7">
          <h2 className="mb-2 flex items-baseline gap-2">
            <span className="text-[15px] font-semibold">{basename(project)}</span>
            <span className="truncate text-[12px] text-ink-2">{project}</span>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5">
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
    <article className={`strip relative rounded-md bg-panel px-3 py-2.5 ${s.state === "dead" ? "opacity-70" : ""}`} data-state={s.state}>
      <a href={href({ name: "session", id: s.id })} className="absolute inset-0 rounded-md" aria-label={`Open ${sessionTitle(s)}`} />
      <div className="flex items-center gap-2">
        <Lamp state={s.state} />
        <span className="min-w-0 flex-1 truncate font-medium">{sessionTitle(s)}</span>
        {s.unsent > 0 ? <UnsentBadge n={s.unsent} /> : null}
        <span className="text-[11px] text-ink-2">{modeLabel[s.mode]}</span>
      </div>
      <p className="mt-1 text-[13px]">
        {stateLabel[s.state]}
        {since ? <span className="text-ink-2">{`, ${since}`}</span> : null}
      </p>
      {s.current_tool ? <p className="truncate text-[13px] text-ink-2">{`Running ${s.current_tool}`}</p> : null}
      {s.failure_streak >= 3 ? (
        <p className="mt-1 text-[12px] text-[var(--sig-wait)]">{`${s.failure_streak} consecutive tool failures`}</p>
      ) : null}
      <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-2">
        <span className="min-w-0 flex-1 truncate">{s.capabilities.label}</span>
        {canTerminal ? (
          <button
            type="button"
            onClick={() => onOpenTerminal(s.id)}
            className="relative z-10 rounded border border-line px-2 py-0.5 text-ink hover:bg-panel-2"
          >
            Terminal
          </button>
        ) : s.mode === "observed" ? (
          <span>External terminal</span>
        ) : null}
      </div>
    </article>
  );
}
