import { useCallback, useEffect, useState } from "react";
import { BareTerminal } from "./components/BareTerminal";
import { LaunchForm } from "./components/LaunchForm";
import { Overview } from "./components/Overview";
import { SessionPage, type ViewMode } from "./components/SessionPage";
import { Sidebar } from "./components/Sidebar";
import { useLive } from "./live";
import { navigate, useRoute } from "./route";

const VIEW_KEY = "foreman.viewMode";

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "terminal" ? "terminal" : "visual";
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
      } else if (e.key === "t" && route.name === "session") {
        e.preventDefault();
        setViewMode("terminal");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewMode, route, setViewMode]);

  if (live.status === "unauthorized" || forcedSignOut) return <SignedOut />;

  let main: React.ReactNode;
  if (live.status === "loading") {
    main = <p className="px-6 py-6 text-ink-2">Loading sessions…</p>;
  } else if (route.name === "launch") {
    main = <LaunchForm sessions={live.sessions} onUnauthorized={onUnauthorized} />;
  } else if (route.name === "terminal") {
    const session = live.sessions.find((s) => s.terminal_id === route.id);
    main = <BareTerminal key={route.id} terminalId={route.id} terminal={live.terminals.find((t) => t.terminal_id === route.id)} session={session} />;
  } else if (route.name === "session") {
    const s = live.sessions.find((x) => x.id === route.id);
    main = s ? (
      <SessionPage key={s.id} s={s} mode={viewMode} setMode={setViewMode} onUnauthorized={onUnauthorized} />
    ) : (
      <div className="px-6 py-6">
        <p>This session isn't known to Foreman.</p>
        <a className="text-accent underline" href="#/">
          Back to all sessions
        </a>
      </div>
    );
  } else {
    main = <Overview sessions={live.sessions} onOpenTerminal={openTerminal} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar sessions={live.sessions} route={route} />
      <main className="flex min-w-0 flex-1 flex-col">
        {live.status === "offline" ? (
          <div className="border-b border-line bg-warn-bg px-5 py-1.5 text-[13px]">
            {`Lost contact with the Foreman daemon${live.error ? ` (${live.error})` : ""}. Agents keep running; reconnecting.`}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{main}</div>
      </main>
    </div>
  );
}

function SignedOut() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md">
        <h1 className="text-[18px] font-semibold tracking-tight">Not signed in</h1>
        <p className="mt-2 text-ink-2">
          Run <code className="font-mono text-[13px] text-ink">foreman open</code> in a terminal. It opens this page with a one-time sign-in link.
        </p>
      </div>
    </div>
  );
}
