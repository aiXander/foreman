import type { SessionView } from "../../shared/api";
import type { TerminalInfo } from "../../shared/ptyproto";
import { basename, sessionTitle } from "../format";
import { href } from "../route";
import { TerminalPane } from "./TerminalPane";

/** A terminal before (or without) a registered session, e.g. right after launch. */
export function BareTerminal({ terminalId, terminal, session }: { terminalId: string; terminal?: TerminalInfo; session?: SessionView }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
        <h1 className="text-[16px] font-semibold tracking-tight">{session ? sessionTitle(session) : "New terminal"}</h1>
        {terminal ? (
          <span className="truncate font-mono text-[12.5px] text-ink-2" title={terminal.cwd}>
            {basename(terminal.cwd)}
          </span>
        ) : null}
        <span className="flex-1" />
        {session ? (
          <a href={href({ name: "session", id: session.id })} className="rounded-md bg-accent px-2.5 py-1 text-[13px] font-medium text-accent-ink">
            Open session card
          </a>
        ) : (
          <span className="text-[12px] text-ink-2">Waiting for Claude to register the session</span>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <TerminalPane terminalId={terminalId} />
      </div>
    </div>
  );
}
