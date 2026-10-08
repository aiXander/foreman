// Page mode (pages plan, items 3–5): the session's plain HTML page in a sandboxed frame on the page
// origin, a thin strip above it (the agent's lamp, what needs the human, the last tell's fate) and
// the tell bridge: a `foreman:tell` from our own frame becomes one `note` batch for the bound agent.
// The frame reloads when the daemon sees its folder change (except for the page's own saves, which
// it writes itself through the page listener). Nothing here writes page files.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PinView, SessionView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { stateLabel } from "../format";
import { TellGate } from "../tell";
import { Lamp } from "./Lamp";

type Note = { tone: "ok" | "bad" | "info"; text: string };
const toneClass = { ok: "text-[var(--sig-work)]", bad: "text-[var(--sig-block)]", info: "text-ink-2" } as const;

/** What the frame needs: the pin it serves (Start agent uses `cwd` and `writable`). */
export type PagePin = Pick<PinView, "pin_id" | "url" | "title" | "path" | "cwd" | "writable">;

export function PagePane({
  pin,
  agent,
  rev,
  onOpenCard,
  onUnauthorized,
}: {
  pin: PagePin;
  /** The session the pin is bound to (its latest foreman_page call); null = none known. */
  agent: SessionView | null;
  rev: number;
  onOpenCard: (() => void) | null;
  onUnauthorized: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const live = agent !== null && agent.state !== "dead";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ground-2/60 px-4 py-2 text-[12.5px]">
        <Lamp state={live ? agent.state : "unknown"} />
        <span className="text-ink-2">{live ? `Agent ${stateLabel[agent.state].toLowerCase()}` : "No agent"}</span>
        <NeedsYou agent={agent} onOpenCard={onOpenCard} onUnauthorized={onUnauthorized} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3" title={pin.path}>
          {pin.path}
        </span>
        {pin.writable.length ? (
          <span className="truncate font-mono text-[11.5px] text-ink-3" title="Files this page saves itself">
            {`edits: ${pin.writable.join(", ")}`}
          </span>
        ) : null}
        {note ? <span className={toneClass[note.tone]}>{note.text}</span> : null}
        {!live ? <StartAgent pin={pin} onNote={setNote} onUnauthorized={onUnauthorized} /> : null}
      </div>
      <PageFrame pin={pin} tellTo={live ? agent.id : null} rev={rev} onNote={setNote} onUnauthorized={onUnauthorized} />
    </div>
  );
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
      className="min-h-0 w-full flex-1 border-0 bg-white"
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

/** Start agent's first prompt: mount the page again with the same title and writable files. */
export function startPrompt(pin: Pick<PagePin, "path" | "title" | "writable">): string {
  const writable = pin.writable.length ? `, and writable ${JSON.stringify(pin.writable)}` : "";
  return `Show the page ${JSON.stringify(pin.path)} in Foreman: call foreman_page with that path, the title ${JSON.stringify(pin.title)}${writable}. Then wait for my messages from it.`;
}

/** A managed Claude in the pin's folder whose first prompt mounts this page, which rebinds the pin. */
function StartAgent({ pin, onNote, onUnauthorized }: { pin: PagePin; onNote: (n: Note) => void; onUnauthorized: () => void }) {
  const [busy, setBusy] = useState(false);
  const start = () => {
    setBusy(true);
    const prompt = startPrompt(pin);
    api
      .launch({ request_id: crypto.randomUUID(), cwd: pin.cwd, prompt })
      .then(() => onNote({ tone: "info", text: "Starting an agent; the page reconnects when it mounts it." }))
      .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : onNote({ tone: "bad", text: e instanceof Error ? e.message : String(e) })))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={start} title={`Launch Claude in ${pin.cwd}`}>
      Start agent
    </button>
  );
}
