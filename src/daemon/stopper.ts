// Stop (D18): one ESC into a managed terminal whose Claude reports a running turn (OSC 9;4 busy).
// ptyd enforces busy / target / cooldown and writes the byte; this side routes a session to its
// terminal and then watches ptyd's own input reading, because an ESC before the first token puts the
// prompt back in the input box as a draft. That draft blocks idle delivery; the card says so and
// offers the terminal. It is never cleared automatically.
import type { StopInfo } from "../shared/api";
import type { JournalState } from "../shared/reducer";
import type { PtydLink } from "./terminals";
import { HttpError } from "./terminals";

const WATCH_FAST_MS = 500;
const WATCH_FAST_FOR_MS = 10_000;
const WATCH_SLOW_MS = 2000;
const WATCH_MAX_MS = 30 * 60_000;

interface Entry extends StopInfo {
  terminal: string;
  /** The interrupted turn has ended (terminal read not-busy); a later busy is a new turn. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class StopControl {
  private stops = new Map<string, Entry>();

  constructor(
    private ptyd: PtydLink,
    private onChange: () => void = () => {},
  ) {}

  view(session: string): StopInfo | null {
    const e = this.stops.get(session);
    return e ? { at: e.at, draft: e.draft } : null;
  }

  async stop(s: JournalState, interruptId: string): Promise<StopInfo> {
    if (s.mode !== "managed") throw new HttpError(409, "Observed sessions have no Stop: Foreman does not own their terminal. Use Pause, or stop it in its own terminal.");
    const term = s.terminal_id ? this.ptyd.terminals.get(s.terminal_id) : undefined;
    if (!term || term.state !== "live" || !s.target) throw new HttpError(409, "The terminal is not running.");
    if (term.target !== s.target) throw new HttpError(409, "The terminal is not routed to this run yet.");
    await this.ptyd.interrupt({ terminal_id: term.terminal_id, target: s.target, interrupt_id: interruptId });
    this.clear(s.session);
    const e: Entry = { at: new Date().toISOString(), draft: false, terminal: term.terminal_id, settled: false, timer: null };
    this.stops.set(s.session, e);
    this.onChange();
    this.schedule(s.session, e, Date.now(), WATCH_FAST_MS);
    return { at: e.at, draft: e.draft };
  }

  stopAll(): void {
    for (const id of [...this.stops.keys()]) this.clear(id);
  }

  private clear(session: string): void {
    const e = this.stops.get(session);
    if (e?.timer) clearTimeout(e.timer);
    this.stops.delete(session);
  }

  private schedule(session: string, e: Entry, started: number, ms: number): void {
    e.timer = setTimeout(() => void this.check(session, e, started), ms);
  }

  /** Follow the terminal after an ESC: record a leftover draft; forget the Stop once a new turn starts. */
  private async check(session: string, e: Entry, started: number): Promise<void> {
    if (this.stops.get(session) !== e) return;
    const term = this.ptyd.terminals.get(e.terminal);
    const elapsed = Date.now() - started;
    if (!term || term.state !== "live" || elapsed > WATCH_MAX_MS) {
      this.clear(session);
      return this.onChange();
    }
    let draft = e.draft;
    try {
      const st = await this.ptyd.inputState(e.terminal);
      if (st.progress === "busy") {
        if (e.settled) {
          this.clear(session); // the human (or a delivery) started a new turn
          return this.onChange();
        }
      } else {
        e.settled = true;
        draft = st.reason === "input box holds a draft";
      }
    } catch {
      // ptyd unreachable: keep what we know, look again later
    }
    if (this.stops.get(session) !== e) return;
    if (draft !== e.draft) {
      e.draft = draft;
      this.onChange();
    }
    this.schedule(session, e, started, elapsed < WATCH_FAST_FOR_MS ? WATCH_FAST_MS : WATCH_SLOW_MS);
  }
}
