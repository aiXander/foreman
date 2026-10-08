// Page mode (pages plan, items 3–5): the session's plain HTML page in a sandboxed frame on the page
// origin, a thin strip above it (the agent's lamp, what needs the human, the last tell's fate) and
// the tell bridge: a `foreman:tell` from our own frame becomes one `note` batch for the bound agent.
// The frame reloads when the daemon sees its folder change (except for the page's own saves, which
// it writes itself through the page listener). Nothing here writes page files.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PinView, SessionView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { stateLabel } from "../format";
import { TellGate } from "../tell";
import { Lamp } from "./Lamp";

type Note = { tone: "ok" | "bad" | "info"; text: string };
const toneClass = { ok: "text-[var(--sig-work)]", bad: "text-[var(--sig-block)]", info: "text-ink-2" } as const;

/** What the frame needs: the pin it serves (Start/Fresh agent shows `cwd`). */
export type PagePin = Pick<PinView, "pin_id" | "url" | "title" | "path" | "cwd" | "writable">;

export function PagePane({
  pin,
  agent,
  rev,
  onOpenCard,
  onUnauthorized,
  side = null,
}: {
  pin: PagePin;
  /** The session the pin is bound to (its latest foreman_page call); null = none known. */
  agent: SessionView | null;
  rev: number;
  onOpenCard: (() => void) | null;
  onUnauthorized: () => void;
  /** The bound agent's card, shown in a column beside the frame (collapsible). */
  side?: ReactNode;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [cardOpen, setCardOpen] = useCardOpen();
  const live = agent !== null && agent.state !== "dead";
  const card = side && cardOpen ? side : null;
  // With the card beside the page, its "needs you" list is right there; otherwise the strip links to it.
  const toCard = side ? () => setCardOpen(true) : onOpenCard;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ground-2/60 px-4 py-2 text-[12.5px]">
        <AgentLamp agent={live ? agent : null} />
        {card ? null : <NeedsYou agent={agent} onOpenCard={toCard} onUnauthorized={onUnauthorized} />}
        <PageInfo pin={pin} />
        {note ? <span className={toneClass[note.tone]}>{note.text}</span> : null}
        <AgentButton pin={pin} fresh={live} onNote={setNote} onUnauthorized={onUnauthorized} />
        {side ? <CardToggle open={cardOpen} setOpen={setCardOpen} /> : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <PageFrame pin={pin} tellTo={live ? agent.id : null} rev={rev} onNote={setNote} onUnauthorized={onUnauthorized} />
        {card ? (
          <aside className="w-[26rem] max-w-[45%] flex-none overflow-y-auto border-l border-line bg-ground-2/50" aria-label="Agent card">
            {card}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function AgentLamp({ agent }: { agent: SessionView | null }) {
  return (
    <>
      <Lamp state={agent ? agent.state : "unknown"} />
      <span className="text-ink-2">{agent ? `Agent ${stateLabel[agent.state].toLowerCase()}` : "No agent"}</span>
    </>
  );
}

/** The page's path and the files it saves itself. */
function PageInfo({ pin }: { pin: PagePin }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3" title={pin.path}>
        {pin.path}
      </span>
      {pin.writable.length ? (
        <span className="truncate font-mono text-[11.5px] text-ink-3" title="Files this page saves itself">
          {`edits: ${pin.writable.join(", ")}`}
        </span>
      ) : null}
    </>
  );
}

function CardToggle({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  return (
    <button type="button" className={`btn btn-sm ${open ? "btn-on" : ""}`} aria-pressed={open} onClick={() => setOpen(!open)} title="Show or hide the agent's card beside the page">
      {open ? "Hide card" : "Show card"}
    </button>
  );
}

const CARD_KEY = "foreman.pageCard";

/** Whether the card column beside pages is open (default yes), remembered per browser. */
function useCardOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(CARD_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(CARD_KEY, v ? "open" : "closed");
    } catch {}
  };
  return [open, set];
}

/** The bound agent's open needs-you items, so a question isn't hidden behind the page. */
function NeedsYou({ agent, onOpenCard, onUnauthorized }: { agent: SessionView | null; onOpenCard: (() => void) | null; onUnauthorized: () => void }) {
  const needs = useNeedsYou(agent, onUnauthorized);
  if (!needs.length || !onOpenCard) return null;
  return (
    <button type="button" className="btn btn-sm max-w-[22rem]" onClick={onOpenCard} title={needs.join("\n")}>
      <span className="lamp !h-1.5 !w-1.5" data-state="waiting_input" />
      <span className="truncate">{`${needs.length} need${needs.length === 1 ? "s" : ""} you: ${needs[0]}`}</span>
    </button>
  );
}

function PageFrame({ pin, tellTo, rev, onNote, onUnauthorized }: { pin: PagePin; tellTo: string | null; rev: number; onNote: (n: Note | null) => void; onUnauthorized: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const gate = useMemo(() => new TellGate(new URL(pin.url).origin), [pin.url]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const v = gate.check(e, frame.current?.contentWindow ?? null, document.activeElement === frame.current);
      if (v.kind === "ignore") return;
      if (v.kind === "refuse") return onNote({ tone: "bad", text: v.reason });
      if (!tellTo) return onNote({ tone: "bad", text: "No agent: start one to send this page's messages." });
      onNote({ tone: "info", text: "Sending…" });
      api
        .tell(tellTo, { batch_id: crypto.randomUUID(), pin_id: pin.pin_id, text: v.text, ...(v.context !== undefined ? { context: v.context } : {}) })
        .then(() => onNote({ tone: "ok", text: "Sent to the agent" }))
        .catch((err) => (err instanceof Unauthorized ? onUnauthorized() : onNote({ tone: "bad", text: err instanceof Error ? err.message : String(err) })));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [gate, tellTo, pin.pin_id, onNote, onUnauthorized]);

  // A file in the page's folder changed: navigate the frame back to the page (replace = no history
  // entry). The cross-origin parent can't call reload() or read the frame's hash; pages keep view
  // state in sessionStorage.
  const seen = useRef(rev);
  useEffect(() => {
    if (rev === seen.current) return;
    seen.current = rev;
    try {
      frame.current?.contentWindow?.location.replace(pin.url);
    } catch {}
  }, [rev, pin.url]);

  return (
    <iframe
      ref={frame}
      src={pin.url}
      title={pin.title}
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      className="min-h-0 min-w-0 flex-1 border-0 bg-white"
    />
  );
}

/** Titles of the bound session's items that need the human (refetched as its journal advances). */
function useNeedsYou(s: SessionView | null, onUnauthorized: () => void): string[] {
  const [titles, setTitles] = useState<string[]>([]);
  const id = s && !s.id.startsWith("reg-") ? s.id : null;
  useEffect(() => {
    if (!id) return setTitles([]);
    let cancelled = false;
    api
      .session(id)
      .then((r) => !cancelled && setTitles(r.work.items.filter((i) => i.actionable).map((i) => i.title)))
      .catch((e) => e instanceof Unauthorized && onUnauthorized());
    return () => {
      cancelled = true;
    };
  }, [id, s?.last_seq, onUnauthorized]);
  return titles;
}

const PREVIOUS = {
  ended: "Fresh agent starting; the old one was told to quit. The page reconnects when the new one mounts it.",
  not_managed: "Fresh agent starting. The old session isn't managed by Foreman, so it keeps running in its own terminal; the page moves to the new one when it mounts.",
  none: "Starting an agent; the page reconnects when it mounts it.",
} as const;

/**
 * Start agent (no live agent) / Fresh agent (P2a): the daemon launches a managed Claude in the pin's
 * folder that remounts this page with the same title and `writable`, then ends the old agent.
 */
function AgentButton({ pin, fresh, onNote, onUnauthorized }: { pin: PagePin; fresh: boolean; onNote: (n: Note) => void; onUnauthorized: () => void }) {
  const [busy, setBusy] = useState(false);
  const start = () => {
    setBusy(true);
    api
      .pinAgent(pin.pin_id)
      .then((r) => onNote({ tone: "info", text: PREVIOUS[r.previous] }))
      .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : onNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })))
      .finally(() => setBusy(false));
  };
  const title = fresh ? `End this agent and start a new one in ${pin.cwd} that mounts the same page (clean context)` : `Launch Claude in ${pin.cwd}`;
  return (
    <button type="button" className={`btn btn-sm ${fresh ? "" : "btn-primary"}`} disabled={busy} onClick={start} title={title}>
      {fresh ? "Fresh agent" : "Start agent"}
    </button>
  );
}
