import type { PinView, SessionView } from "../../shared/api";
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

/** The Foreman mark: a gradient tile with an F. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="flex-none drop-shadow-[0_0_12px_rgb(165_151_255/0.35)]">
      <defs>
        <linearGradient id="foreman-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c3b9ff" />
          <stop offset="1" stopColor="#7f8cff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#foreman-logo)" />
      <path d="M10 9h13v3.4h-9.2v3.2h7.6V19h-7.6v5H10z" fill="#0c0a1f" />
    </svg>
  );
}

export function Sidebar({ sessions, pins, route }: { sessions: SessionView[]; pins: PinView[]; route: Route }) {
  const groups = groupByProject(sessions);
  const activeId = route.name === "session" ? route.id : null;
  return (
    <nav className="flex h-full w-64 flex-none flex-col border-r border-line bg-ground-2/80 backdrop-blur-xl" aria-label="Sessions">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <a href={href({ name: "overview" })} className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-ink hover:text-white">
          <Logo />
          Foreman
        </a>
        <a
          href={href({ name: "launch" })}
          className={`btn btn-sm ${route.name === "launch" ? "btn-on" : "btn-primary"}`}
        >
          <span aria-hidden className="-ml-0.5 text-[14px] leading-none">+</span>
          Launch
        </a>
      </div>
      <div className="mx-4 h-px bg-gradient-to-r from-line-2 via-line to-transparent" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-4">
        <PinsSection pins={pins} sessions={sessions} activePin={route.name === "page" ? route.id : null} />
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-[13px] text-ink-3">No sessions yet.</p>
        ) : (
          groups.map(([project, list]) => (
            <section key={project} className="mt-4 first:mt-0">
              <h2 className="eyebrow flex items-center gap-2 truncate px-2 pb-1.5" title={project}>
                <span className="truncate">{basename(project)}</span>
                <span className="font-mono font-normal tracking-normal text-ink-3/70">{list.length}</span>
              </h2>
              <ul className="space-y-px">
                {list.map((s) => (
                  <li key={s.id}>
                    <SessionLink s={s} active={activeId === s.id} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <SidebarFooter n={sessions.length} />
    </nav>
  );
}

function SessionLink({ s, active }: { s: SessionView; active: boolean }) {
  return (
    <a
      href={href({ name: "session", id: s.id })}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink aria-[current=page]:bg-panel-3 aria-[current=page]:text-white aria-[current=page]:shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] ${
        s.state === "dead" ? "opacity-55" : ""
      }`}
    >
      <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-2 hidden w-[3px] rounded-r bg-accent shadow-[0_0_10px_var(--accent)] group-aria-[current=page]:block" />
      <Lamp state={s.state} />
      <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
      {s.unsent > 0 ? <UnsentBadge n={s.unsent} /> : null}
      <span className="flex-none text-[10.5px] text-ink-3">{modeLabel[s.mode]}</span>
    </a>
  );
}

/** Pages pinned by foreman_page calls, above the sessions; they outlive the session that mounted them. */
function PinsSection({ pins, sessions, activePin }: { pins: PinView[]; sessions: SessionView[]; activePin: string | null }) {
  if (!pins.length) return null;
  return (
    <section className="mb-4">
      <h2 className="eyebrow px-2 pb-1.5">Pages</h2>
      <ul className="space-y-px">
        {pins.map((p) => (
          <li key={p.pin_id}>
            <PinLink p={p} agent={sessions.find((s) => s.id === p.session) ?? null} active={activePin === p.pin_id} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A pinned page: lamp = its bound agent (hollow when there is none or it ended). */
function PinLink({ p, agent, active }: { p: PinView; agent: SessionView | null; active: boolean }) {
  const live = agent !== null && agent.state !== "dead";
  return (
    <a
      href={href({ name: "page", id: p.pin_id })}
      aria-current={active ? "page" : undefined}
      title={p.path}
      className="group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink aria-[current=page]:bg-panel-3 aria-[current=page]:text-white aria-[current=page]:shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
    >
      <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-2 hidden w-[3px] rounded-r bg-accent shadow-[0_0_10px_var(--accent)] group-aria-[current=page]:block" />
      <Lamp state={live ? agent.state : "unknown"} title={live ? undefined : "No agent"} />
      <span className="min-w-0 flex-1 truncate">{p.title}</span>
      {live ? null : <span className="flex-none text-[10.5px] text-ink-3">no agent</span>}
    </a>
  );
}

/** Keyboard hint for the view toggle (App's ` shortcut) and the session count. */
function SidebarFooter({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[11.5px] text-ink-3">
      <span className="kbd text-[13px]">`</span>
      <span>card ⇄ terminal</span>
      <span className="flex-1" />
      <span className="tabular-nums">{`${n} session${n === 1 ? "" : "s"}`}</span>
    </div>
  );
}

/** Staged in the send tray, not sent: visible everywhere, never auto-sent (plan §11). */
export function UnsentBadge({ n }: { n: number }) {
  return (
    <span
      className="flex-none rounded-full bg-accent px-1.5 py-px text-[10.5px] font-semibold text-accent-ink shadow-[0_0_10px_rgb(165_151_255/0.45)]"
      title={`${n} staged action${n === 1 ? "" : "s"} not sent yet`}
    >
      {`${n} unsent`}
    </span>
  );
}
