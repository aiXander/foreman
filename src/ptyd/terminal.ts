// One ptyd-owned PTY + child process + headless emulator. Output, resize and exit form one
// ordered stream (`seq`); a bounded delta ring serves reconnects, and emulator snapshots serve
// fresh or stale viewers. The emulator sees every mutation through its write queue, so a
// snapshot taken in a write callback is exactly "the state after seq N".
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as XTerm } from "@xterm/headless";
import type { Subprocess } from "bun";
import { processStart } from "../shared/proc";
import { b64, SNAPSHOT_CHUNK_BYTES, type InputState, type InterruptResult, type Progress, type Push, type SubmitResult, type TerminalInfo } from "../shared/ptyproto";
import { inputBox, progressFromOsc, readiness } from "./readiness";

const RING_BYTES = 4 * 1024 * 1024;
const SCROLLBACK = 10_000;
const OUTPUT_PIECE = 48 * 1024; // keeps every output frame well under MAX_FRAME_BYTES
const INPUT_DEDUPE = 1024;
const EXIT_FLUSH_MS = 250; // wait for trailing PTY output before emitting `exit`
const DISPOSE_AFTER_EXIT_MS = 60_000;
// Idle submit confirmation: these bound how long we wait for the TUI to show the paste and to
// report a started turn. They are timeouts on observed events, never readiness by themselves.
const ECHO_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 15_000;
const POLL_MS = 15;
const SUBMIT_DEDUPE = 256;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** The side of a connection a terminal talks to. Implemented by the server's Conn. */
export interface ViewerSink {
  /** Live stream frame; subject to the slow-consumer limit. */
  sendLive(frame: Push): void;
  /** Snapshot/replay/control frame; exempt from the slow-consumer limit. */
  sendExempt(frame: Push): void;
}

interface Viewer {
  viewerId: string;
  sink: ViewerSink;
  /** False while a snapshot/replay is being prepared; live frames are held back (they sit in the ring). */
  live: boolean;
}

interface RingEntry {
  seq: number;
  frame: Push;
  bytes: number;
}

// Parent-agent variables that must not leak into a hosted Claude (e.g. CLAUDE_CODE_CHILD_SESSION
// turns transcript saving off) and launcher identities that must not bind to a ptyd session.
const SCRUB_EXACT = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);
const SCRUB_PREFIX = ["CLAUDE_CODE_", "CMUX_", "C11_"];

function childEnv(base: Record<string, string | undefined>, terminalId: string, launchId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SCRUB_EXACT.has(k) || SCRUB_PREFIX.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  // ptyd's own FOREMAN_HOME wins: hooks must write where this ptyd's daemon reads.
  if (process.env.FOREMAN_HOME) env.FOREMAN_HOME = process.env.FOREMAN_HOME;
  else delete env.FOREMAN_HOME;
  env.TERM = "xterm-256color";
  env.FOREMAN_TERMINAL_ID = terminalId;
  env.FOREMAN_LAUNCH_ID = launchId;
  return env;
}

/**
 * Length of the longest prefix of `b` that doesn't end inside a UTF-8 sequence. Only a
 * well-formed-looking incomplete tail (lead byte + fewer continuations than it announces) is
 * held back; invalid bytes pass straight through for the emulator to handle.
 */
function completeUtf8Prefix(b: Uint8Array): number {
  const n = b.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const x = b[n - back]!;
    if ((x & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = x >= 0xf0 && x <= 0xf4 ? 4 : x >= 0xe0 ? 3 : x >= 0xc2 && x < 0xe0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

export interface CreateOptions {
  cwd: string;
  argv: string[];
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
}

export class PtyTerminal {
  readonly id = crypto.randomUUID();
  readonly launchId = crypto.randomUUID();
  readonly createdAt = new Date().toISOString();
  readonly cwd: string;
  readonly argv: string[];
  readonly pid: number;
  readonly pidStart: string | null;
  cols: number;
  rows: number;
  state: "live" | "exited" = "live";
  exit: { code: number | null; signal: string | null } | null = null;
  exitedAt: string | null = null;
  target: string | null = null;
  writer: string | null = null;
  inputEpoch = 0;
  seq = 0;
  /** Claude's own busy/idle report (OSC 9;4), parsed in stream order by the emulator. */
  progress: Progress = "none";
  /** True while an idle submit is typing: viewer writes and resizes are refused meanwhile. */
  submitting = false;

  private proc: Subprocess;
  private xt: XTerm | null;
  private ser: SerializeAddon | null;
  /** Kept after the emulator is disposed so exited terminals can still be viewed. */
  private finalSnapshot: { seq: number; data: string; cols: number; rows: number } | null = null;
  private ring: RingEntry[] = [];
  private ringBytes = 0;
  private viewers = new Map<string, Viewer>();
  private inputs = new Map<string, number>();
  private procExited = false;
  private ptyClosed = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private carry: Uint8Array = new Uint8Array(0);
  private submits = new Map<string, Promise<SubmitResult>>();

  constructor(
    opts: CreateOptions,
    readonly streamEpoch: string,
    private onChange: (t: PtyTerminal) => void,
  ) {
    this.cwd = opts.cwd;
    this.argv = opts.argv;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.xt = new XTerm({ cols: opts.cols, rows: opts.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.ser = new SerializeAddon();
    this.xt.loadAddon(this.ser as any);
    // Single-responder rule: the headless emulator answers terminal queries (DA, DSR...) only
    // while no viewer holds the writer lease; otherwise the controlling viewer's own terminal
    // answers. Race: a query parsed just before a lease change is answered by the old responder.
    this.xt.onData((d) => this.respond(d));
    this.xt.onBinary((d) => this.respond(Buffer.from(d, "binary")));
    this.xt.parser.registerOscHandler(9, (data) => {
      const p = progressFromOsc(data);
      if (p && p !== this.progress) {
        this.progress = p;
        this.onChange(this);
      }
      return false; // not consumed: other OSC 9 uses stay untouched
    });

    this.proc = Bun.spawn(opts.argv, {
      cwd: opts.cwd,
      env: childEnv(opts.env, this.id, this.launchId),
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        data: (_t, d) => this.onOutput(d),
        exit: () => {
          this.ptyClosed = true;
          this.maybeFinish();
        },
      },
      onExit: () => {
        this.procExited = true;
        this.maybeFinish();
      },
    });
    this.pid = this.proc.pid;
    this.pidStart = processStart(this.pid);
  }

  info(): TerminalInfo {
    return {
      terminal_id: this.id,
      cwd: this.cwd,
      argv: this.argv,
      pid: this.pid,
      pid_start: this.pidStart,
      cols: this.cols,
      rows: this.rows,
      state: this.state,
      exit: this.exit,
      created_at: this.createdAt,
      exited_at: this.exitedAt,
      target: this.target,
      writer: this.writer,
      viewers: this.viewers.size,
      stream_epoch: this.streamEpoch,
      last_seq: this.seq,
      input_epoch: this.inputEpoch,
      launch_id: this.launchId,
      progress: this.progress,
    };
  }

  // ---- stream ----------------------------------------------------------------------------

  private respond(d: string | Uint8Array): void {
    if (this.writer === null && this.state === "live") this.proc.terminal?.write(d);
  }

  private onOutput(chunk: Uint8Array): void {
    // Hold back an incomplete trailing UTF-8 sequence so every frame (and so every snapshot
    // boundary) ends on a character boundary: a snapshot can't carry a decoder's partial state.
    let d = chunk;
    if (this.carry.length) {
      d = new Uint8Array(this.carry.length + chunk.length);
      d.set(this.carry);
      d.set(chunk, this.carry.length);
    }
    const cut = completeUtf8Prefix(d);
    this.carry = d.slice(cut);
    this.emitOutput(d.subarray(0, cut));
  }

  private emitOutput(d: Uint8Array): void {
    for (let o = 0; o < d.length; ) {
      let end = Math.min(d.length, o + OUTPUT_PIECE);
      if (end < d.length) end = o + (completeUtf8Prefix(d.subarray(o, end)) || end - o);
      const piece = d.slice(o, end); // copy: the callback buffer may be reused
      const frame: Push = { v: 1, event: "output", terminal_id: this.id, stream_epoch: this.streamEpoch, seq: ++this.seq, data_b64: b64.encode(piece) };
      this.xt?.write(piece);
      this.emit(frame, piece.length);
      o = end;
    }
  }

  private emit(frame: Push & { seq: number }, bytes: number): void {
    this.ring.push({ seq: frame.seq, frame, bytes });
    this.ringBytes += bytes;
    while (this.ringBytes > RING_BYTES && this.ring.length > 1) this.ringBytes -= this.ring.shift()!.bytes;
    for (const v of this.viewers.values()) if (v.live) v.sink.sendLive(frame);
  }

  private maybeFinish(): void {
    if (this.state === "exited" || !this.procExited) return;
    if (this.ptyClosed) return this.finish();
    this.exitTimer ??= setTimeout(() => this.finish(), EXIT_FLUSH_MS);
  }

  private finish(): void {
    if (this.state === "exited") return;
    if (this.exitTimer) clearTimeout(this.exitTimer);
    if (this.carry.length) this.emitOutput(this.carry); // flush a dangling partial sequence as-is
    this.carry = new Uint8Array(0);
    this.state = "exited";
    this.exitedAt = new Date().toISOString();
    this.exit = { code: this.proc.exitCode, signal: this.proc.signalCode ?? null };
    this.writer = null;
    const frame: Push = { v: 1, event: "exit", terminal_id: this.id, stream_epoch: this.streamEpoch, seq: ++this.seq, code: this.exit.code, signal: this.exit.signal };
    this.emit(frame, 64);
    try {
      this.proc.terminal?.close();
    } catch {}
    this.onChange(this);
    setTimeout(() => this.disposeEmulator(), DISPOSE_AFTER_EXIT_MS).unref?.();
  }

  private disposeEmulator(): void {
    const xt = this.xt;
    if (!xt || !this.ser) return;
    const seq = this.seq;
    xt.write("", () => {
      this.finalSnapshot = { seq, data: this.ser!.serialize({ scrollback: SCROLLBACK }), cols: xt.cols, rows: xt.rows };
      xt.dispose();
      this.xt = null;
      this.ser = null;
    });
  }

  // ---- viewers ---------------------------------------------------------------------------

  hasViewer(viewerId: string, sink: ViewerSink): boolean {
    return this.viewers.get(viewerId)?.sink === sink;
  }

  /**
   * Attach a viewer. Reconnects whose epoch/cursor still fit the ring get deltas; everyone
   * else gets a snapshot at a boundary N followed by events N+1... Returns the mode; frames are
   * sent by `start()`, which the server calls after the attach response is written.
   */
  attach(viewerId: string, sink: ViewerSink, afterSeq?: number, epoch?: string): { mode: "replay" | "snapshot"; start: () => void } {
    const existing = this.viewers.get(viewerId);
    if (existing && existing.sink !== sink) throw new Error("viewer_id attached on another connection");
    const v: Viewer = { viewerId, sink, live: false };
    this.viewers.set(viewerId, v);
    const firstSeq = this.ring[0]?.seq ?? this.seq + 1;
    const canReplay = epoch === this.streamEpoch && afterSeq !== undefined && afterSeq <= this.seq && afterSeq >= firstSeq - 1;
    if (canReplay) {
      return {
        mode: "replay",
        start: () => {
          for (const e of this.ring) if (e.seq > afterSeq!) sink.sendExempt(e.frame);
          v.live = true;
        },
      };
    }
    return { mode: "snapshot", start: () => this.snapshot(v, 0) };
  }

  private snapshot(v: Viewer, attempt: number): void {
    const deliver = (n: number, data: string, cols: number, rows: number) => {
      if (this.viewers.get(v.viewerId) !== v) return;
      const firstSeq = this.ring[0]?.seq ?? this.seq + 1;
      if (this.seq > n && firstSeq > n + 1) {
        // Output overflowed the ring while the snapshot was pending: take a newer one.
        if (attempt < 3) return this.snapshot(v, attempt + 1);
        v.sink.sendExempt({ v: 1, event: "resync_required", terminal_id: this.id, viewer_id: v.viewerId, reason: "output outran snapshot" });
        this.detach(v.viewerId);
        return;
      }
      const base = { v: 1 as const, terminal_id: this.id, viewer_id: v.viewerId };
      v.sink.sendExempt({ ...base, event: "snapshot_begin", stream_epoch: this.streamEpoch, seq: n, cols, rows });
      const bytes = new TextEncoder().encode(data);
      for (let o = 0; o < bytes.length; o += SNAPSHOT_CHUNK_BYTES) {
        v.sink.sendExempt({ ...base, event: "snapshot_chunk", data_b64: b64.encode(bytes.subarray(o, o + SNAPSHOT_CHUNK_BYTES)) });
      }
      v.sink.sendExempt({ ...base, event: "snapshot_end", seq: n });
      for (const e of this.ring) if (e.seq > n) v.sink.sendExempt(e.frame);
      v.live = true;
    };
    const xt = this.xt;
    if (!xt) {
      const f = this.finalSnapshot!;
      return deliver(f.seq, f.data, f.cols, f.rows);
    }
    const n = this.seq;
    // Callback runs once every chunk queued before it (seq <= n) has been parsed, and before
    // any later chunk: the serialized state is exactly the state after seq n.
    xt.write("", () => {
      if (this.xt !== xt) return this.snapshot(v, attempt); // disposed meanwhile
      deliver(n, this.ser!.serialize({ scrollback: SCROLLBACK }), xt.cols, xt.rows);
    });
  }

  detach(viewerId: string): boolean {
    if (!this.viewers.delete(viewerId)) return false;
    if (this.writer === viewerId) this.setWriter(null);
    else this.onChange(this);
    return true;
  }

  viewerIdsFor(sink: ViewerSink): string[] {
    return [...this.viewers.values()].filter((v) => v.sink === sink).map((v) => v.viewerId);
  }

  detachSink(sink: ViewerSink): void {
    for (const v of [...this.viewers.values()]) if (v.sink === sink) this.detach(v.viewerId);
  }

  // ---- control / input -------------------------------------------------------------------

  private setWriter(w: string | null): void {
    this.writer = w;
    for (const v of this.viewers.values()) v.sink.sendExempt({ v: 1, event: "control", terminal_id: this.id, writer: w });
    this.onChange(this);
  }

  control(viewerId: string, action: "acquire" | "release" | "takeover"): string | null {
    if (action === "release") {
      if (this.writer === viewerId) this.setWriter(null);
    } else if (action === "takeover" || this.writer === null) {
      if (this.writer !== viewerId) this.setWriter(viewerId);
    }
    return this.writer;
  }

  write(viewerId: string, inputId: string, data: Uint8Array): { accepted: number; duplicate: boolean } {
    const prior = this.inputs.get(inputId);
    if (prior !== undefined) return { accepted: prior, duplicate: true };
    this.proc.terminal!.write(data);
    this.inputEpoch++;
    this.inputs.set(inputId, data.length);
    if (this.inputs.size > INPUT_DEDUPE) this.inputs.delete(this.inputs.keys().next().value!);
    return { accepted: data.length, duplicate: false };
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.proc.terminal!.resize(cols, rows);
      const xt = this.xt;
      // Through the write queue, so bytes emitted at the old size are parsed at the old size.
      xt?.write("", () => xt.resize(cols, rows));
      this.emit({ v: 1, event: "resize", terminal_id: this.id, stream_epoch: this.streamEpoch, seq: ++this.seq, cols, rows }, 32);
    }
    this.onChange(this);
  }

  // ---- idle delivery ---------------------------------------------------------------------

  /** Resolves once the emulator has parsed every byte received so far (false if it is gone). */
  private parsed(): Promise<boolean> {
    const xt = this.xt;
    if (!xt || this.state !== "live") return Promise.resolve(false);
    return new Promise((res) => xt.write("", () => res(this.xt === xt && this.state === "live")));
  }

  /** Poll the parsed screen until `pred` holds; resolves the elapsed ms, or null on timeout/exit. */
  private async waitFor(pred: () => boolean, ms: number): Promise<number | null> {
    const t0 = performance.now();
    for (;;) {
      if (!(await this.parsed())) return null;
      if (pred()) return Math.round(performance.now() - t0);
      if (performance.now() - t0 > ms) return null;
      await Bun.sleep(POLL_MS);
    }
  }

  async inputState(): Promise<InputState> {
    const epoch = this.inputEpoch;
    const live = await this.parsed();
    const r = !live ? { ready: false as const, reason: "terminal has exited" } : this.submitting ? { ready: false as const, reason: "a submit is in progress" } : readiness(this.xt!, this.progress);
    // A write that raced the parse makes this reading stale: report it blocked rather than guess.
    const stale = epoch !== this.inputEpoch;
    return {
      input_epoch: epoch,
      target: this.target,
      writer: this.writer,
      progress: this.progress,
      ready: r.ready && !stale,
      reason: stale ? "input changed while reading" : r.ready ? null : r.reason,
    };
  }

  /**
   * Type one batch into a blank idle prompt as a new turn. The caller has already checked
   * target, epoch and lease (see server `submit`); this re-checks readiness on the parsed screen,
   * then pastes the lead line and the body as two bracketed pastes, waits until the input box
   * shows them, presses Enter, and waits for Claude to report a busy turn. Viewer writes are
   * refused for the whole sequence. Throws `NotReady` before writing anything.
   */
  priorSubmit(attemptId: string): Promise<SubmitResult> | undefined {
    return this.submits.get(attemptId);
  }

  submit(attemptId: string, lead: string, text: string): Promise<SubmitResult> {
    this.submitting = true;
    const run = this.runSubmit(lead, text).finally(() => {
      this.submitting = false;
    });
    this.submits.set(attemptId, run);
    if (this.submits.size > SUBMIT_DEDUPE) this.submits.delete(this.submits.keys().next().value!);
    run.catch(() => this.submits.delete(attemptId)); // nothing was written: a retry may try again
    return run;
  }

  private async runSubmit(lead: string, text: string): Promise<SubmitResult> {
    if (!(await this.parsed())) throw new NotReady("terminal has exited");
    const r = readiness(this.xt!, this.progress);
    if (!r.ready) throw new NotReady(r.reason);
    const term = this.proc.terminal!;
    // Lead and body are separate pastes: Claude collapses a paste over 800 chars or 3 lines into
    // "[Pasted text #n]" and hands it to the model as <pasted_content> (data, not instructions),
    // so the short lead stays the user's own words and tells the model to act on the block.
    term.write(`${PASTE_START}${lead}\n${PASTE_END}`);
    term.write(`${PASTE_START}${text}${PASTE_END}`);
    this.inputEpoch++;
    const echo = await this.waitFor(() => inputBox(this.xt!) !== "empty", ECHO_TIMEOUT_MS);
    if (echo === null) return { status: "uncertain", stage: "echo", echo_ms: null, start_ms: null, input_epoch: this.inputEpoch };
    // Claude went busy on its own while the paste landed: Enter would queue the batch behind that
    // turn, not start a clean one. Leave the text in the box and report it uncertain.
    if (this.progress !== "idle") return { status: "uncertain", stage: "start", echo_ms: echo, start_ms: null, input_epoch: this.inputEpoch };
    term.write("\r");
    const start = await this.waitFor(() => this.progress === "busy", START_TIMEOUT_MS);
    this.inputEpoch++;
    return { status: start === null ? "uncertain" : "submitted", stage: start === null ? "start" : null, echo_ms: echo, start_ms: start, input_epoch: this.inputEpoch };
  }

  /** interrupt_id → its result, so a retried Stop never becomes a second ESC (double-ESC opens rewind). */
  private interrupts = new Map<string, InterruptResult>();
  private lastInterrupt = 0;

  priorInterrupt(interruptId: string): InterruptResult | undefined {
    return this.interrupts.get(interruptId);
  }

  /** ms since the last interrupt this terminal took (Infinity if none). */
  sinceInterrupt(): number {
    return this.lastInterrupt ? performance.now() - this.lastInterrupt : Infinity;
  }

  /** Stop (D18): one ESC into a busy turn. The server has checked busy, target and cooldown. */
  interrupt(interruptId: string): InterruptResult {
    this.proc.terminal!.write("\x1b");
    this.inputEpoch++;
    this.lastInterrupt = performance.now();
    const r: InterruptResult = { interrupted: true, input_epoch: this.inputEpoch };
    this.interrupts.set(interruptId, r);
    if (this.interrupts.size > SUBMIT_DEDUPE) this.interrupts.delete(this.interrupts.keys().next().value!);
    return r;
  }

  bind(target: string | null): void {
    this.target = target;
    this.inputEpoch++; // any readiness assertion is void after a rebind
    this.onChange(this);
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.state === "exited") return false;
    this.proc.kill(signal);
    return true;
  }

  /** ptyd shutdown: hang up the child. */
  hangup(): void {
    try {
      if (this.state === "live") this.proc.kill("SIGHUP");
      this.proc.terminal?.close();
    } catch {}
  }
}

/** Idle submit refused before any byte was written. */
export class NotReady extends Error {}
