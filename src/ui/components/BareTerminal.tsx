import type { SessionView } from "../../shared/api";
import type { TerminalInfo } from "../../shared/ptyproto";
import { basename, sessionTitle } from "../format";
import { href } from "../route";
import { TerminalPane } from "./TerminalPane";

/** A terminal before (or without) a registered session, e.g. right after launch. */
export function BareTerminal({ terminalId, terminal, session }: { terminalId: string; terminal?: TerminalInfo; session?: SessionView }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ground-2/60 px-6 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          {terminal ? (
            <p className="truncate font-mono text-[11px] text-ink-3" title={terminal.cwd}>
              {basename(terminal.cwd)}
            </p>
          ) : null}
          <h1 className="truncate text-[17px] leading-tight font-semibold tracking-tight text-white">{session ? sessionTitle(session) : "New terminal"}</h1>
        </div>
        <span className="flex-1" />
        {session ? (
          <a href={href({ name: "session", id: session.id })} className="btn btn-primary">
            Open session card
          </a>
        ) : (
          <span className="flex items-center gap-2 text-[12px] text-ink-3">
            <span className="lamp" data-state="starting" />
            Waiting for Claude to register the session
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <TerminalPane terminalId={terminalId} />
      </div>
    </div>
  );
}
