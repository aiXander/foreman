// A pinned page on its own (#/page/<pin>): it outlives the session that mounted it. With a live bound
// agent its tells go there; without one the frame still renders and the strip offers Start agent.
import { useState } from "react";
import type { PinView, SessionView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { sessionTitle } from "../format";
import { navigate } from "../route";
import { PagePane } from "./PagePane";
import { SideCard } from "./SideCard";

export function PinPage({
  pin,
  agent,
  rev,
  onOpenSession,
  onOpenTerminal,
  onUnauthorized,
}: {
  pin: PinView;
  agent: SessionView | null;
  rev: number;
  onOpenSession: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const live = agent !== null && agent.state !== "dead";
  const side = live ? (
    <SideCard
      key={agent.id}
      s={agent}
      onOpenCard={() => onOpenSession(agent.id)}
      onOpenTerminal={agent.mode === "managed" && agent.terminal_id ? () => onOpenTerminal(agent.id) : null}
      onUnauthorized={onUnauthorized}
    />
  ) : null;
  const [error, setError] = useState<string | null>(null);
  const hide = () =>
    api
      .hidePin(pin.pin_id)
      .then(() => navigate({ name: "overview" }))
      .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : setError(e instanceof Error ? e.message : String(e))));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ground-2/60 px-6 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          <p className="eyebrow">Page</p>
          <h1 className="truncate text-[17px] leading-tight font-semibold tracking-tight text-white">{pin.title}</h1>
        </div>
        <span className="flex-1" />
        {agent ? (
          <button type="button" className="btn-link text-[13px]" onClick={() => onOpenSession(agent.id)}>
            {`Open ${sessionTitle(agent)}`}
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={hide} title="Hide it from the sidebar; the next foreman_page call for this file shows it again">
          Remove from sidebar
        </button>
        {error ? <span className="text-[12px] text-[var(--sig-block)]">{error}</span> : null}
      </header>
      <div className="min-h-0 flex-1">
        <PagePane pin={pin} agent={agent} rev={rev} onOpenCard={agent ? () => onOpenSession(agent.id) : null} onUnauthorized={onUnauthorized} side={side} />
      </div>
    </div>
  );
}
