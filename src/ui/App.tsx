import { useCallback, useEffect, useState } from "react";
import { BareTerminal } from "./components/BareTerminal";
import { LaunchForm } from "./components/LaunchForm";
import { Overview } from "./components/Overview";
import { PinPage } from "./components/PinPage";
import { SessionPage, type SessionPageMount, type ViewMode } from "./components/SessionPage";
import { Logo, Sidebar } from "./components/Sidebar";
import type { SessionView } from "../shared/api";
import { type Live, useLive } from "./live";
import { navigate, useRoute } from "./route";

const VIEW_KEY = "foreman.viewMode";
const SIDEBAR_KEY = "foreman.sidebar";

function loadViewMode(): ViewMode {
  try {
    const m = localStorage.getItem(VIEW_KEY);
    return m === "terminal" || m === "page" ? m : "visual";
  } catch {
    return "visual";
  }
}

/** Keys never fire while typing in a form field or the terminal (xterm uses a textarea). */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.closest(".xterm") !== null;
}

export function App() {
  const live = useLive();
  const route = useRoute();
  const [forcedSignOut, setForcedSignOut] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);

  const setViewMode = useCallback((m: ViewMode) => {
    setViewModeState(m);
    try {
      localStorage.setItem(VIEW_KEY, m);
    } catch {}
  }, []);
  const onUnauthorized = useCallback(() => setForcedSignOut(true), []);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? "open" : "collapsed");
      } catch {}
      return !c;
    });
  }, []);

  const openTerminal = useCallback(
    (id: string) => {
      setViewMode("terminal");
      navigate({ name: "session", id });
    },
    [setViewMode],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "`") {
        e.preventDefault();
        setViewMode(viewMode === "visual" ? "terminal" : "visual");
      } else if (e.key === "[") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "t" && route.name === "session") {
        e.preventDefault();
        setViewMode("terminal");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewMode, route, setViewMode, toggleSidebar]);

  if (live.status === "unauthorized" || forcedSignOut) return <SignedOut />;

  let main: React.ReactNode;
  if (live.status === "loading") {
    main = (
      <p className="flex items-center gap-2.5 px-8 py-8 text-ink-3">
        <span className="lamp" data-state="starting" />
        Loading sessions…
      </p>
    );
  } else if (route.name === "launch") {
    main = <LaunchForm sessions={live.sessions} onUnauthorized={onUnauthorized} />;
  } else if (route.name === "terminal") {
    const session = live.sessions.find((s) => s.terminal_id === route.id);
    main = <BareTerminal key={route.id} terminalId={route.id} terminal={live.terminals.find((t) => t.terminal_id === route.id)} session={session} />;
  } else if (route.name === "page") {
    main = <PinRoute live={live} pinId={route.id} setViewMode={setViewMode} onOpenTerminal={openTerminal} onUnauthorized={onUnauthorized} />;
  } else if (route.name === "session") {
    const s = live.sessions.find((x) => x.id === route.id);
    main = s ? (
      <SessionPage key={s.id} s={s} page={pageMount(live, s)} mode={viewMode} setMode={setViewMode} onUnauthorized={onUnauthorized} />
    ) : (
      <div className="enter px-8 py-10">
        <p className="text-[15px] text-ink">This session isn't known to Foreman.</p>
        <a className="btn-link mt-2 inline-block text-[13px]" href="#/">
          Back to all sessions
        </a>
      </div>
    );
  } else {
    main = <Overview sessions={live.sessions} onOpenTerminal={openTerminal} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar sessions={live.sessions} pins={live.pins} route={route} collapsed={collapsed} onToggle={toggleSidebar} />
      <main className="flex min-w-0 flex-1 flex-col">
        {live.status === "offline" ? (
          <div className="flex items-center gap-2.5 border-b border-[rgb(255_194_74/0.25)] bg-warn-bg px-5 py-2 text-[13px] text-[#ffe2a3]">
            <span className="lamp" data-state="waiting_input" />
            {`Lost contact with the Foreman daemon${live.error ? ` (${live.error})` : ""}. Agents keep running; reconnecting.`}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{main}</div>
      </main>
    </div>
  );
}

/** A session's mounted page, resolved through its pin: tells go to the pin's bound session. */
function pageMount(live: Live, s: SessionView): SessionPageMount | null {
  if (!s.page) return null;
  const pin = live.pins.find((p) => p.pin_id === s.page!.pin_id);
  const agentId = pin ? pin.session : s.id;
  return {
    pin: { ...s.page, cwd: pin?.cwd ?? s.cwd },
    agent: live.sessions.find((x) => x.id === agentId) ?? null,
    rev: live.pageRev[s.page.pin_id] ?? 0,
  };
}

function PinRoute({ live, pinId, setViewMode, onOpenTerminal, onUnauthorized }: { live: Live; pinId: string; setViewMode: (m: ViewMode) => void; onOpenTerminal: (id: string) => void; onUnauthorized: () => void }) {
  const pin = live.pins.find((p) => p.pin_id === pinId);
  if (!pin) {
    return (
      <div className="enter px-8 py-10">
        <p className="text-[15px] text-ink">This page isn't pinned in Foreman.</p>
        <a className="btn-link mt-2 inline-block text-[13px]" href="#/">
          Back to all sessions
        </a>
      </div>
    );
  }
  const openSession = (id: string) => {
    setViewMode("visual");
    navigate({ name: "session", id });
  };
  const agent = live.sessions.find((x) => x.id === pin.session) ?? null;
  return <PinPage key={pin.pin_id} pin={pin} agent={agent} rev={live.pageRev[pin.pin_id] ?? 0} onOpenSession={openSession} onOpenTerminal={onOpenTerminal} onUnauthorized={onUnauthorized} />;
}

function SignedOut() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="surface enter max-w-md px-8 py-8">
        <Logo size={36} />
        <h1 className="mt-5 text-[20px] font-semibold tracking-tight text-white">Not signed in</h1>
        <p className="mt-2 text-ink-2">
          Run <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[13px] text-ink">foreman open</code> in a terminal. It opens this page with a
          one-time sign-in link.
        </p>
      </div>
    </div>
  );
}
