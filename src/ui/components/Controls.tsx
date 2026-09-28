// Pause and Stop (D18): they bypass the tray. Pause = a cooperative "finish this step and end your
// turn" batch, delivered ahead of queued sends. Stop = one ESC into a managed terminal while Claude
// reports a running turn; if it leaves the prompt as a draft, the card says so and links the
// terminal (nothing clears it automatically). Observed sessions get Pause only.
import { useState } from "react";
import type { SessionView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { relTime } from "../format";

const btn = "rounded border border-line bg-panel-2 px-2.5 py-0.5 text-[13px] font-medium hover:border-accent disabled:opacity-50";

export function Controls({ s, now, onOpenTerminal, onUnauthorized }: { s: SessionView; now: number; onOpenTerminal: () => void; onUnauthorized: () => void }) {
  const [busy, setBusy] = useState<"pause" | "stop" | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  if (!s.capabilities.cards || !s.run || s.state === "dead") return null;
  const managed = s.mode === "managed";
  const running = s.terminal_progress === "busy";

  const act = (which: "pause" | "stop") => {
    setBusy(which);
    setMsg(null);
    (which === "pause" ? api.pause(s.id) : api.stop(s.id))
      // A Stop's outcome shows in the persistent notice below (it tracks the leftover draft).
      .then(() => setMsg(which === "pause" ? { bad: false, text: "Pause queued ahead of other sends. The agent gets it at its next tool call; if the turn ends first it is dropped as not needed." } : null))
      .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : setMsg({ bad: true, text: e instanceof Error ? e.message : String(e) })))
      .finally(() => setBusy(null));
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={() => act("pause")} className={btn} title="Ask the agent to finish or safely stop its current step, record progress and end its turn">
          Pause
        </button>
        {managed ? (
          <button
            type="button"
            disabled={busy !== null || !running}
            onClick={() => act("stop")}
            className={btn}
            title={running ? "Interrupt the running turn now (one Esc); the conversation is kept" : "Claude isn't running a turn: nothing to stop"}
          >
            Stop
          </button>
        ) : null}
        <span className="text-[12px] text-ink-2">{managed ? "Pause asks politely; Stop interrupts now." : "Pause asks the agent to wrap up. No Stop: this terminal isn't Foreman's."}</span>
      </div>
      {msg ? <p className={`mt-1 text-[13px] ${msg.bad ? "text-[var(--sig-block)]" : "text-ink-2"}`}>{msg.text}</p> : null}
      {s.stop ? (
        <div className={`mt-2 rounded px-2 py-1 text-[13px] ${s.stop.draft ? "bg-warn-bg" : "bg-panel-2"}`}>
          {`Stopped ${relTime(s.stop.at, now)}.`}
          {s.stop.draft ? (
            <>
              {" Claude put the interrupted prompt back in its input box. It stays there (Foreman never clears it) and holds back idle delivery until you send or clear it. "}
              <button type="button" onClick={onOpenTerminal} className="font-medium text-accent underline">
                Open the terminal
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
