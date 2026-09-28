// Idle delivery (plan §9.2 route 3): a managed session whose Claude sits at a blank idle prompt
// gets its head batch typed in by ptyd `submit` as a new turn. The rule proven in phase 0: read
// ptyd's `input_state`, claim in the journal (fsynced) BEFORE any byte is typed, then settle with
// what ptyd reports. No lock is held across `submit`; an unconfirmed paste stays `uncertain` and
// holds the queue until the human retries. Also records why a queued batch is still waiting, for
// the card. Observed sessions are never woken here (D10): their batches wait for a hook.
import { claimNext, idleLead, settle, type Claim } from "../shared/delivery";
import { PtyError } from "../shared/ptyclient";
import type { PtyErrorCode, TerminalInfo } from "../shared/ptyproto";
import type { JournalState } from "../shared/reducer";
import { LOCK_TIMEOUT } from "../shared/store";
import { queueHead } from "../shared/work";
import type { Projection } from "./projection";
import type { PtydLink } from "./terminals";

const TICK_MS = 1000;
/** After a not-ready reading or a refused submit, look again no sooner than this. */
const BACKOFF_MS = 1000;
/** ptyd refused before writing a byte: the attempt definitively failed and the batch is eligible again. */
const NOTHING_WRITTEN = new Set<PtyErrorCode>(["NOT_READY", "CONFLICT", "EXITED", "NOT_FOUND", "FORBIDDEN", "LIMIT"]);

export class IdleWorker {
  private inflight = new Set<string>();
  private notBefore = new Map<string, number>();
  /** session → why its queued batch hasn't been typed (only while the terminal reads idle). */
  private reasons = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private projection: Projection,
    private ptyd: PtydLink,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poke(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  reason(session: string): string | null {
    return this.reasons.get(session) ?? null;
  }

  private setReason(session: string, reason: string | null): void {
    if ((this.reasons.get(session) ?? null) === reason) return;
    if (reason) this.reasons.set(session, reason);
    else this.reasons.delete(session);
    for (const cb of this.listeners) cb();
  }

  /** Look for idle managed terminals with a deliverable head batch. Cheap; call on any change. */
  poke(): void {
    const now = Date.now();
    for (const s of this.projection.states()) {
      const term = this.eligible(s);
      if (!term) {
        this.setReason(s.session, null);
        continue;
      }
      if (this.inflight.has(term.terminal_id) || (this.notBefore.get(term.terminal_id) ?? 0) > now) continue;
      this.inflight.add(term.terminal_id);
      void this.attempt(s, term).finally(() => this.inflight.delete(term.terminal_id));
    }
  }

  /** A live managed terminal routed to this session's current run, reporting idle, with work queued. */
  private eligible(s: JournalState): TerminalInfo | null {
    if (s.mode !== "managed" || !s.run || !s.target || !s.terminal_id || s.state === "dead") return null;
    const head = queueHead(s.work, s.run);
    if (!head || !("batch" in head)) return null;
    const t = this.ptyd.terminals.get(s.terminal_id);
    if (!t || t.state !== "live" || t.target !== s.target || t.progress !== "idle") return null;
    return t;
  }

  private async attempt(s: JournalState, term: TerminalInfo): Promise<void> {
    const run = s.run!;
    const target = s.target!;
    const tid = term.terminal_id;
    const backoff = () => this.notBefore.set(tid, Date.now() + BACKOFF_MS);
    try {
      const head = queueHead(s.work, run);
      if (head && "batch" in head && head.batch.kind === "pause") {
        // A pause would start a turn only to end it: claiming on the idle route cancels it as moot.
        claimNext(s.session, "idle_submit", { expectRun: run, lockTimeoutMs: LOCK_TIMEOUT.mutation });
        return;
      }
      const st = await this.ptyd.inputState(tid);
      if (st.writer) return (backoff(), this.setReason(s.session, "someone holds terminal control; release it to deliver"));
      if (!st.ready || st.target !== target) return (backoff(), this.setReason(s.session, st.ready ? "terminal is being rerouted" : (st.reason ?? "input not ready")));
      this.setReason(s.session, null);
      const claim = claimNext(s.session, "idle_submit", { expectRun: run, lockTimeoutMs: LOCK_TIMEOUT.mutation });
      if (claim) await this.submit(claim, tid, target, st.input_epoch, backoff);
    } catch (e) {
      backoff();
      console.error(`idle delivery ${s.session}: ${(e as Error).message}`);
    }
  }

  /** Type the claimed batch. Every path settles the attempt; a lost reply is uncertain, never failed. */
  private async submit(claim: Claim, tid: string, target: string, epoch: number, backoff: () => void): Promise<void> {
    let outcome: "transport_sent" | "failed" | "uncertain";
    let detail: string | null = null;
    try {
      const r = await this.ptyd.submit({ terminal_id: tid, target, attempt_id: claim.attempt_id, expected_input_epoch: epoch, lead: idleLead(claim.batch_id), text: claim.text });
      outcome = r.status === "submitted" ? "transport_sent" : "uncertain";
      if (r.stage) detail = r.stage === "echo" ? "the paste never showed in the input box" : "Claude never reported a started turn";
    } catch (e) {
      const code = e instanceof PtyError ? e.code : null;
      outcome = code && NOTHING_WRITTEN.has(code) ? "failed" : "uncertain";
      detail = `${code ?? "error"}: ${(e as Error).message}`;
      if (outcome === "failed") backoff();
    }
    // An unsettled attempt holds the queue and shows as stuck: try hard to record the outcome.
    for (let i = 0; ; i++) {
      try {
        return settle(claim, outcome, detail);
      } catch (e) {
        if (i >= 4) throw e;
        await Bun.sleep(200 * (i + 1));
      }
    }
  }
}
