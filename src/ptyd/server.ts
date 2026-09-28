// ptyd socket server: owns every PTY; independent of the web daemon. Closing a browser or
// restarting foremand leaves agents running. Protocol: src/shared/ptyproto.ts.
import type { Socket, UnixSocketListener } from "bun";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { writeServiceRecord } from "../shared/config";
import { ensureDir, paths } from "../shared/paths";
import { Outbox, PtyClient } from "../shared/ptyclient";
import { b64, FrameReader, INTERRUPT_COOLDOWN_MS, MAX_SUBMIT_BYTES, MAX_SUBMIT_LEAD, MAX_WRITE_BYTES, PTY_PROTOCOL, VIEWER_QUEUE_BYTES, type PtyErrorCode, type Push } from "../shared/ptyproto";
import { NotReady, PtyTerminal, type ViewerSink } from "./terminal";

const MAX_EXITED = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNALS = new Set(["SIGTERM", "SIGHUP", "SIGKILL"]);

class Fail extends Error {
  constructor(
    public code: PtyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const need = (ok: unknown, message: string): void => {
  if (!ok) throw new Fail("BAD_REQUEST", message);
};
const isUuid = (x: unknown): x is string => typeof x === "string" && UUID.test(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
// Submitted text: printable Unicode, newlines and tabs only. No ESC (it could end the paste
// frame early), no other C0/C1 controls, no DEL.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// A lead that starts with / ! # @ or & would switch the prompt into a slash command, bash mode,
// memory, file mention or background mode instead of starting a turn.
const LEAD = /^[\p{L}\p{N}\[(]/u;

class Conn implements ViewerSink {
  client: "cli" | "daemon" | null = null;
  outbox: Outbox;
  reader: FrameReader;
  closed = false;

  constructor(
    readonly socket: Socket<Conn>,
    private server: PtydServer,
  ) {
    this.outbox = new Outbox(socket);
    this.reader = new FrameReader(
      (f) => server.handle(this, f),
      () => {
        this.outbox.send({ v: 1, id: null, ok: false, error: { code: "LIMIT", message: "malformed or oversized frame" } }, true);
        socket.end();
      },
    );
  }

  sendLive(frame: Push): void {
    if (this.closed) return;
    this.outbox.send(frame);
    // Slow consumer: never block the child or grow without bound. Drop what hasn't started
    // writing, tell every viewer on this connection to resync, and detach them.
    if (this.outbox.liveBytes > VIEWER_QUEUE_BYTES) this.server.overflow(this);
  }

  sendExempt(frame: unknown): void {
    if (!this.closed) this.outbox.send(frame, true);
  }
}

export class PtydServer {
  readonly streamEpoch = crypto.randomUUID();
  private terminals = new Map<string, PtyTerminal>();
  private byRequest = new Map<string, string>();
  private conns = new Set<Conn>();
  private listener: UnixSocketListener<Conn> | null = null;

  constructor(readonly socketPath: string) {}

  start(): void {
    // sockaddr_un.sun_path is 104 bytes on macOS (108 on Linux); a long FOREMAN_HOME can't host the socket.
    if (Buffer.byteLength(this.socketPath) > 103) {
      throw new Error(`socket path is ${Buffer.byteLength(this.socketPath)} bytes (max 103): ${this.socketPath} — use a shorter FOREMAN_HOME`);
    }
    ensureDir(dirname(this.socketPath));
    this.listener = Bun.listen<Conn>({
      unix: this.socketPath,
      socket: {
        open: (s) => {
          s.data = new Conn(s, this);
          this.conns.add(s.data);
        },
        data: (s, d) => s.data.reader.push(d),
        drain: (s) => s.data.outbox.flush(),
        close: (s) => this.dropConn(s.data),
        error: (s) => this.dropConn(s.data),
      },
    });
    chmodSync(this.socketPath, 0o600);
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
    for (const t of this.terminals.values()) t.hangup();
    try {
      unlinkSync(this.socketPath);
    } catch {}
  }

  private dropConn(c: Conn | undefined): void {
    if (!c || c.closed) return;
    c.closed = true;
    this.conns.delete(c);
    for (const t of this.terminals.values()) t.detachSink(c);
  }

  overflow(c: Conn): void {
    c.outbox.dropUnstarted();
    for (const t of this.terminals.values()) {
      for (const viewerId of t.viewerIdsFor(c)) {
        c.sendExempt({ v: 1, event: "resync_required", terminal_id: t.id, viewer_id: viewerId, reason: "viewer too slow" });
        t.detach(viewerId);
      }
    }
  }

  private broadcast(t: PtyTerminal): void {
    const frame = { v: 1, event: "terminal", terminal: t.info() };
    for (const c of this.conns) if (c.client === "daemon") c.sendLive(frame as Push);
  }

  private pruneExited(): void {
    const exited = [...this.terminals.values()].filter((t) => t.state === "exited").sort((a, b) => a.exitedAt!.localeCompare(b.exitedAt!));
    for (const t of exited.slice(0, Math.max(0, exited.length - MAX_EXITED))) this.terminals.delete(t.id);
  }

  handle(c: Conn, f: any): void {
    const id = typeof f?.id === "string" ? f.id : null;
    const fail = (e: any) => {
      const code: PtyErrorCode = e instanceof Fail ? e.code : e instanceof NotReady ? "NOT_READY" : "BAD_REQUEST";
      c.sendExempt({ v: 1, id, ok: false, error: { code, message: e?.message ?? String(e) } });
    };
    let after: (() => void) | undefined;
    try {
      if (!f || typeof f !== "object") throw new Fail("BAD_REQUEST", "frame must be an object");
      if (f.v !== PTY_PROTOCOL) throw new Fail("UNSUPPORTED_VERSION", `protocol v${f.v} unsupported; ptyd speaks v${PTY_PROTOCOL}`);
      need(id, "id required");
      if (f.op !== "hello" && !c.client) throw new Fail("BAD_REQUEST", "hello must be the first request");
      const out = this.dispatch(c, f);
      if (out instanceof Promise) {
        // Async ops (input_state, submit) answer when done; responses are matched by id.
        out.then((r) => c.sendExempt({ v: 1, id, ok: true, result: r.result }), fail);
        return;
      }
      after = out.after;
      c.sendExempt({ v: 1, id, ok: true, result: out.result });
    } catch (e: any) {
      fail(e);
    }
    after?.();
  }

  private terminal(id: unknown): PtyTerminal {
    const t = typeof id === "string" ? this.terminals.get(id) : undefined;
    if (!t) throw new Fail("NOT_FOUND", `no terminal ${id}`);
    return t;
  }

  private attached(c: Conn, f: any): PtyTerminal {
    need(isUuid(f.viewer_id), "viewer_id must be a UUID");
    const t = this.terminal(f.terminal_id);
    if (!t.hasViewer(f.viewer_id, c)) throw new Fail("NOT_FOUND", "viewer is not attached on this connection");
    return t;
  }

  private dispatch(c: Conn, f: any): { result: unknown; after?: () => void } | Promise<{ result: unknown }> {
    switch (f.op) {
      case "hello":
        need(f.client === "cli" || f.client === "daemon", "client must be cli or daemon");
        c.client = f.client;
        return { result: { protocol: PTY_PROTOCOL, stream_epoch: this.streamEpoch, pid: process.pid } };

      case "create": {
        need(isUuid(f.request_id), "request_id must be a UUID");
        const prior = this.byRequest.get(f.request_id);
        if (prior && this.terminals.has(prior)) return { result: { terminal: this.terminals.get(prior)!.info() } };
        need(typeof f.cwd === "string" && isAbsolute(f.cwd), "cwd must be an absolute path");
        need(existsSync(f.cwd) && statSync(f.cwd).isDirectory(), "cwd must be an existing directory");
        need(Array.isArray(f.argv) && f.argv.length >= 1 && f.argv.length <= 64, "argv must have 1..64 entries");
        need(f.argv.every((a: unknown) => typeof a === "string" && a.length <= 8192) && f.argv[0], "argv entries must be strings");
        need(isInt(f.cols, 20, 500), "cols must be an integer 20..500");
        need(isInt(f.rows, 5, 200), "rows must be an integer 5..200");
        need(f.env === undefined || (typeof f.env === "object" && f.env && Object.values(f.env).every((v) => typeof v === "string")), "env must map strings to strings");
        let t: PtyTerminal;
        try {
          t = new PtyTerminal({ cwd: f.cwd, argv: f.argv, cols: f.cols, rows: f.rows, env: f.env ?? process.env }, this.streamEpoch, (x) => {
            if (x.state === "exited") this.pruneExited();
            this.broadcast(x);
          });
        } catch (e: any) {
          throw new Fail("BAD_REQUEST", `spawn failed: ${e?.message ?? e}`);
        }
        this.terminals.set(t.id, t);
        this.byRequest.set(f.request_id, t.id);
        this.broadcast(t);
        return { result: { terminal: t.info() } };
      }

      case "list":
        return { result: { terminals: [...this.terminals.values()].map((t) => t.info()) } };

      case "attach": {
        need(isUuid(f.viewer_id), "viewer_id must be a UUID");
        need(f.after_seq === undefined || isInt(f.after_seq, 0, Number.MAX_SAFE_INTEGER), "after_seq must be a nonnegative integer");
        need(f.stream_epoch === undefined || isUuid(f.stream_epoch), "stream_epoch must be a UUID");
        const t = this.terminal(f.terminal_id);
        let a: ReturnType<PtyTerminal["attach"]>;
        try {
          a = t.attach(f.viewer_id, c, f.after_seq, f.stream_epoch);
        } catch (e: any) {
          throw new Fail("CONFLICT", e.message);
        }
        this.broadcast(t);
        return { result: { terminal: t.info(), mode: a.mode }, after: a.start };
      }

      case "detach": {
        const t = this.attached(c, f);
        t.detach(f.viewer_id);
        return { result: { detached: true } };
      }

      case "control": {
        need(["acquire", "release", "takeover"].includes(f.action), "action must be acquire, release or takeover");
        const t = this.attached(c, f);
        if (t.state === "exited" && f.action !== "release") throw new Fail("EXITED", "terminal has exited");
        return { result: { writer: t.control(f.viewer_id, f.action) } };
      }

      case "write": {
        const t = this.attached(c, f);
        need(isUuid(f.input_id), "input_id must be a UUID");
        need(typeof f.data_b64 === "string", "data_b64 required");
        if (t.state === "exited") throw new Fail("EXITED", "terminal has exited");
        if (t.writer !== f.viewer_id) throw new Fail("NOT_WRITER", "acquire control before writing");
        if (t.submitting) throw new Fail("CONFLICT", "a delivery is being typed; retry in a moment");
        const data = b64.decode(f.data_b64);
        if (data.length > MAX_WRITE_BYTES) throw new Fail("LIMIT", `write exceeds ${MAX_WRITE_BYTES} bytes`);
        return { result: t.write(f.viewer_id, f.input_id, data) };
      }

      case "resize": {
        const t = this.attached(c, f);
        need(isInt(f.cols, 20, 500) && isInt(f.rows, 5, 200), "cols 20..500 and rows 5..200 required");
        if (t.state === "exited") throw new Fail("EXITED", "terminal has exited");
        if (t.writer !== f.viewer_id) throw new Fail("NOT_WRITER", "acquire control before resizing");
        if (t.submitting) throw new Fail("CONFLICT", "a delivery is being typed; retry in a moment");
        t.resize(f.cols, f.rows);
        return { result: { cols: t.cols, rows: t.rows } };
      }

      case "bind": {
        if (c.client !== "daemon") throw new Fail("FORBIDDEN", "bind is daemon-only");
        const t = this.terminal(f.terminal_id);
        need(f.target === null || isUuid(f.target), "target must be a UUID or null");
        need(f.expected_target === null || isUuid(f.expected_target), "expected_target must be a UUID or null");
        if (t.target !== f.expected_target) throw new Fail("CONFLICT", `current target is ${t.target}`);
        t.bind(f.target);
        return { result: { target: t.target } };
      }

      case "kill": {
        const t = this.terminal(f.terminal_id);
        const signal = f.signal ?? "SIGTERM";
        need(SIGNALS.has(signal), "signal must be SIGTERM, SIGHUP or SIGKILL");
        return { result: { signaled: t.kill(signal) } };
      }

      case "input_state": {
        if (c.client !== "daemon") throw new Fail("FORBIDDEN", "input_state is daemon-only");
        const t = this.terminal(f.terminal_id);
        return t.inputState().then((result) => ({ result }));
      }

      case "submit": {
        if (c.client !== "daemon") throw new Fail("FORBIDDEN", "submit is daemon-only");
        const t = this.terminal(f.terminal_id);
        need(isUuid(f.target), "target must be a UUID");
        need(isUuid(f.attempt_id), "attempt_id must be a UUID");
        // A retried attempt (e.g. after a daemon reconnect) gets the original outcome, never a second paste.
        const prior = t.priorSubmit(f.attempt_id);
        if (prior) return prior.then((result) => ({ result }));
        need(isInt(f.expected_input_epoch, 0, Number.MAX_SAFE_INTEGER), "expected_input_epoch must be a nonnegative integer");
        need(typeof f.lead === "string" && f.lead.length <= MAX_SUBMIT_LEAD && LEAD.test(f.lead) && !/[\n\r]/.test(f.lead) && !UNSAFE_TEXT.test(f.lead), "lead must be one printable line starting with a letter, digit, [ or (");
        need(typeof f.text === "string" && f.text.trim().length > 0, "text required");
        const text = f.text.replace(/\r\n?/g, "\n");
        need(!UNSAFE_TEXT.test(text), "text may contain only printable characters, newlines and tabs");
        if (Buffer.byteLength(text) > MAX_SUBMIT_BYTES) throw new Fail("LIMIT", `text exceeds ${MAX_SUBMIT_BYTES} bytes`);
        if (t.state === "exited") throw new Fail("EXITED", "terminal has exited");
        if (t.target !== f.target) throw new Fail("CONFLICT", `stale target: terminal routes to ${t.target}`);
        if (t.writer !== null) throw new Fail("CONFLICT", "a viewer holds control; delivery waits for release");
        if (t.submitting) throw new Fail("CONFLICT", "another submit is in progress");
        if (t.inputEpoch !== f.expected_input_epoch) throw new Fail("CONFLICT", `input changed: epoch is ${t.inputEpoch}`);
        return t.submit(f.attempt_id, f.lead, text).then((result) => ({ result }));
      }

      case "interrupt": {
        if (c.client !== "daemon") throw new Fail("FORBIDDEN", "interrupt is daemon-only");
        const t = this.terminal(f.terminal_id);
        need(isUuid(f.target), "target must be a UUID");
        need(isUuid(f.interrupt_id), "interrupt_id must be a UUID");
        const prior = t.priorInterrupt(f.interrupt_id);
        if (prior) return { result: prior };
        if (t.state === "exited") throw new Fail("EXITED", "terminal has exited");
        if (t.target !== f.target) throw new Fail("CONFLICT", `stale target: terminal routes to ${t.target}`);
        if (t.submitting) throw new Fail("CONFLICT", "a delivery is being typed; retry in a moment");
        // Never an ESC into an idle prompt: it does nothing there at best, and a second one opens rewind.
        if (t.progress !== "busy") throw new Fail("NOT_READY", `Claude is not working (it reports ${t.progress}); nothing to stop`);
        if (t.sinceInterrupt() < INTERRUPT_COOLDOWN_MS) throw new Fail("CONFLICT", "just interrupted; wait a moment before stopping again");
        return { result: t.interrupt(f.interrupt_id) };
      }

      default:
        throw new Fail("UNKNOWN_OP", `unknown op ${JSON.stringify(f.op)}`);
    }
  }
}

/** Start ptyd on `socketPath`. Refuses when another ptyd answers on it; clears a stale socket. */
export async function startPtyd(opts: { socket?: string; writeRecord?: boolean } = {}): Promise<PtydServer> {
  const socketPath = opts.socket ?? paths.ptydSock();
  if (existsSync(socketPath)) {
    let live = false;
    try {
      (await PtyClient.connect({ client: "cli", socket: socketPath })).close();
      live = true;
    } catch {}
    if (live) throw new Error(`ptyd already running on ${socketPath}`);
    unlinkSync(socketPath);
  }
  const server = new PtydServer(socketPath);
  server.start();
  if (opts.writeRecord !== false) writeServiceRecord(paths.ptydInfo(), socketPath, PTY_PROTOCOL);
  return server;
}
