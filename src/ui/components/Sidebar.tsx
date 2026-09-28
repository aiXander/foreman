import type { SessionView } from "../../shared/api";
import { basename, modeLabel, sessionTitle, sortSessions } from "../format";
import { href, type Route } from "../route";
import { Lamp } from "./Lamp";

export function groupByProject(sessions: SessionView[]): [string, SessionView[]][] {
  const groups = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const g = groups.get(s.project) ?? [];
    g.push(s);
    groups.set(s.project, g);
  }
  return [...groups.entries()]
    .map(([p, list]) => [p, sortSessions(list)] as [string, SessionView[]])
    .sort((a, b) => basename(a[0]).localeCompare(basename(b[0])) || a[0].localeCompare(b[0]));
}

export function Sidebar({ sessions, route }: { sessions: SessionView[]; route: Route }) {
  const groups = groupByProject(sessions);
  const activeId = route.name === "session" ? route.id : null;
  return (
    <nav className="flex h-full w-64 flex-none flex-col border-r border-line bg-panel" aria-label="Sessions">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <a href={href({ name: "overview" })} className="text-[15px] font-semibold tracking-tight text-ink">
          Foreman
        </a>
        <a
          href={href({ name: "launch" })}
          className={`rounded-md px-2.5 py-1 text-[13px] font-medium ${
            route.name === "launch" ? "bg-panel-2 text-ink" : "bg-accent text-accent-ink hover:opacity-90"
          }`}
        >
          Launch
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-[13px] text-ink-2">No sessions yet.</p>
        ) : (
          groups.map(([project, list]) => (
            <section key={project} className="mt-3 first:mt-0">
              <h2 className="truncate px-2 pb-1 text-[12px] font-semibold text-ink-2" title={project}>
                {basename(project)}
              </h2>
              <ul>
                {list.map((s) => (
                  <li key={s.id}>
                    <a
                      href={href({ name: "session", id: s.id })}
                      aria-current={activeId === s.id ? "page" : undefined}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
                        activeId === s.id ? "bg-panel-2 text-ink" : "text-ink hover:bg-panel-2"
                      } ${s.state === "dead" ? "opacity-60" : ""}`}
                    >
                      <Lamp state={s.state} />
                      <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
                      {s.unsent > 0 ? <UnsentBadge n={s.unsent} /> : null}
                      <span className="flex-none text-[11px] text-ink-2">{modeLabel[s.mode]}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  );
}

/** Staged in the send tray, not sent: visible everywhere, never auto-sent (plan §11). */
export function UnsentBadge({ n }: { n: number }) {
  return (
    <span className="flex-none rounded bg-accent px-1.5 text-[11px] font-semibold text-accent-ink" title={`${n} staged action${n === 1 ? "" : "s"} not sent yet`}>
      {`${n} unsent`}
    </span>
  );
}
