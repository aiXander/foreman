// ptyd socket protocol v1: newline-delimited UTF-8 JSON over a Unix stream socket.
// Terminal bytes are always base64 (`data_b64`), never raw text split on newlines.

export const PTY_PROTOCOL = 1;
const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_WRITE_BYTES = 32 * 1024;
export const VIEWER_QUEUE_BYTES = 1024 * 1024;
export const SNAPSHOT_CHUNK_BYTES = 48 * 1024; // pre-base64, keeps frames well under the cap
/** Idle delivery (`submit`): body cap, and the one-line provenance lead typed before it. */
export const MAX_SUBMIT_BYTES = 16 * 1024;
export const MAX_SUBMIT_LEAD = 300;

/** Last OSC 9;4 progress state the child reported ("none" until the first report). */
export type Progress = "none" | "idle" | "busy" | "error" | "paused";

export type PtyErrorCode =
  | "BAD_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_OP"
  | "NOT_FOUND"
  | "NOT_WRITER"
  | "EXITED"
  | "CONFLICT"
  | "FORBIDDEN"
  | "NOT_READY"
  | "RESYNC_REQUIRED"
  | "LIMIT";

export interface TerminalInfo {
  terminal_id: string;
  cwd: string;
  argv: string[];
  pid: number;
  pid_start: string | null;
  cols: number;
  rows: number;
  state: "live" | "exited";
  exit: { code: number | null; signal: string | null } | null;
  created_at: string;
  exited_at: string | null;
  /** Current session/run route handle (set by daemon `bind`), or null. */
  target: string | null;
  /** viewer_id holding the writer/resize lease, or null. */
  writer: string | null;
  viewers: number;
  stream_epoch: string;
  last_seq: number;
  /** Bumped by every viewer write, rebind and idle submit: readiness is only valid at one epoch. */
  input_epoch: number;
  launch_id: string;
  progress: Progress;
}

/** `input_state` result: ptyd's own read of its emulator, valid only at `input_epoch`. */
export interface InputState {
  input_epoch: number;
  target: string | null;
  writer: string | null;
  progress: Progress;
  ready: boolean;
  reason: string | null;
}

/** `submit` result. `uncertain` means bytes were written but the TUI never confirmed them. */
export interface SubmitResult {
  status: "submitted" | "uncertain";
  /** Where confirmation stopped: the paste never showed in the input box, or no turn started. */
  stage: "echo" | "start" | null;
  echo_ms: number | null;
  start_ms: number | null;
  input_epoch: number;
}

/** `interrupt` result: exactly one ESC was written to a terminal that reported busy. */
export interface InterruptResult {
  interrupted: true;
  input_epoch: number;
}

/** Refuse a second interrupt this soon after the last one: two quick ESCs open Claude's rewind menu. */
export const INTERRUPT_COOLDOWN_MS = 1500;

export type Request =
  | { v: 1; id: string; op: "hello"; client: "cli" | "daemon"; }
  // `env`: the trusted caller's environment, used in memory only (never persisted or listed).
  // ptyd scrubs parent-agent variables (CLAUDECODE, CLAUDE_CODE_*, CMUX_*, C11_*...) and adds FOREMAN_*.
  | { v: 1; id: string; op: "create"; request_id: string; cwd: string; argv: string[]; cols: number; rows: number; env?: Record<string, string> }
  | { v: 1; id: string; op: "list" }
  | { v: 1; id: string; op: "attach"; terminal_id: string; viewer_id: string; after_seq?: number; stream_epoch?: string }
  | { v: 1; id: string; op: "detach"; terminal_id: string; viewer_id: string }
  | { v: 1; id: string; op: "control"; terminal_id: string; viewer_id: string; action: "acquire" | "release" | "takeover" }
  | { v: 1; id: string; op: "write"; terminal_id: string; viewer_id: string; input_id: string; data_b64: string }
  | { v: 1; id: string; op: "resize"; terminal_id: string; viewer_id: string; cols: number; rows: number }
  | { v: 1; id: string; op: "bind"; terminal_id: string; target: string | null; expected_target: string | null }
  // Daemon-only idle delivery. `submit` re-checks readiness itself, excludes viewer writes while it
  // pastes `lead` + `text` and presses Enter, and is idempotent per `attempt_id`.
  | { v: 1; id: string; op: "input_state"; terminal_id: string }
  | { v: 1; id: string; op: "submit"; terminal_id: string; target: string; attempt_id: string; expected_input_epoch: number; lead: string; text: string }
  // Daemon-only Stop: one ESC, only while the terminal's OSC 9;4 state is busy; idempotent per interrupt_id.
  | { v: 1; id: string; op: "interrupt"; terminal_id: string; target: string; interrupt_id: string }
  | { v: 1; id: string; op: "kill"; terminal_id: string; signal?: "SIGTERM" | "SIGHUP" | "SIGKILL" };

export type Response =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: PtyErrorCode; message: string } };

/** Pushed frames. All events of one terminal share one ordered stream per viewer. */
export type Push =
  | { v: 1; event: "snapshot_begin"; terminal_id: string; viewer_id: string; stream_epoch: string; seq: number; cols: number; rows: number }
  | { v: 1; event: "snapshot_chunk"; terminal_id: string; viewer_id: string; data_b64: string }
  | { v: 1; event: "snapshot_end"; terminal_id: string; viewer_id: string; seq: number }
  | { v: 1; event: "output"; terminal_id: string; stream_epoch: string; seq: number; data_b64: string }
  | { v: 1; event: "resize"; terminal_id: string; stream_epoch: string; seq: number; cols: number; rows: number }
  | { v: 1; event: "exit"; terminal_id: string; stream_epoch: string; seq: number; code: number | null; signal: string | null }
  | { v: 1; event: "control"; terminal_id: string; writer: string | null }
  | { v: 1; event: "resync_required"; terminal_id: string; viewer_id: string; reason: string }
  /** Lifecycle/metadata change (created, exited, bound, writer, resized); sent to every `daemon` connection. */
  | { v: 1; event: "terminal"; terminal: TerminalInfo };

/** Split a byte stream into complete newline-terminated JSON frames. Handles partial/coalesced reads. */
export class FrameReader {
  private buf = "";
  private dec = new TextDecoder();
  constructor(private onFrame: (frame: any) => void, private onError: (err: Error) => void = () => {}) {}

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        this.onFrame(JSON.parse(line));
      } catch (e) {
        this.onError(e as Error);
      }
    }
    if (this.buf.length > MAX_FRAME_BYTES) {
      this.buf = "";
      this.onError(new Error("frame exceeds limit"));
    }
  }
}

export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + "\n";
}

export const b64 = {
  encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64"),
  decode: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
};
