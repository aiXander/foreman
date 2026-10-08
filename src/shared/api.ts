// Daemon ⇄ browser contract (REST under /api/v1, SSE, terminal WebSocket). The UI imports
// these types directly; the daemon is the only producer.
import type { BatchAction } from "./protocol";
import type { Progress, TerminalInfo } from "./ptyproto";
import type { BriefState, HandoverState, ItemState, ProgressState } from "./work";

export type ActivityState =
  | "starting" // SessionStart seen, no turn yet
  | "working" // prompt submitted / tool running
  | "waiting_permission" // native permission dialog (blocking)
  | "waiting_input" // native question / elicitation / picker
  | "finishing" // Stop seen; input readiness not confirmed
  | "idle" // Claude reported idle at its prompt (idle_prompt notification)
  | "dead" // process/run ended
  | "unknown"; // missing or stale evidence

export type SessionMode = "managed" | "observed" | "registry_only";

export interface Capabilities {
  /** Foreman owns a live PTY for it (one click to terminal). */
  terminal: boolean;
  /** Plugin hooks report activity (cards). */
  cards: boolean;
  /** How human steering can reach it once phase 2 lands. */
  steer: "none" | "busy_only" | "full";
  /** One-line honest label shown on the card. */
  label: string;
}

export interface SessionView {
  /** Foreman session UUID, or `reg-<native id>` for registry-only discoveries. */
  id: string;
  vendor: "claude";
  native_id: string;
  project: string;
  cwd: string;
  mode: SessionMode;
  capabilities: Capabilities;
  /** Claude's own session name from its registry, a display/address hint only. */
  name: string | null;
  run: string | null;
  terminal_id: string | null;
  terminal_state: "live" | "exited" | null;
  model: string | null;
  state: ActivityState;
  state_since: string | null;
  last_event_at: string | null;
  current_tool: string | null;
  recent_paths: string[];
  tool_calls: number;
  tool_failures: number;
  /** Consecutive failed tool calls; 3+ shows a factual warning (no inferred task failure). */
  failure_streak: number;
  subagents_active: number;
  process: "alive" | "dead" | "unknown";
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_seq: number;
  /** Human batches in flight for this session; null when nothing is queued, stuck or unseen. */
  delivery: DeliverySummary | null;
  /** Actions staged in the send tray and not sent yet (the unsent badge). */
  unsent: number;
  /** The managed terminal's own busy/idle report (OSC 9;4); null without a live terminal. */
  terminal_progress: Progress | null;
  /** The last Stop (one ESC) on this session's terminal, until its next turn starts. */
  stop: StopInfo | null;
  /** The page this session mounted (foreman_page), with the pin that serves it; null = none. */
  page: SessionPage | null;
}

export interface SessionPage {
  pin_id: string;
  path: string;
  title: string;
  /** The frame URL on the page origin (carries the pin's capability token). */
  url: string;
  /** What the page may save itself, relative to its folder ("data.json", "inbox/"); [] = read-only. */
  writable: string[];
}

/**
 * A page pin (plan 01_pages item 5): outlives its session, listed in the sidebar. `session` is the
 * session whose latest foreman_page call named this file; tells go only to it.
 */
export interface PinView {
  pin_id: string;
  path: string;
  title: string;
  url: string;
  session: string | null;
  /** Where "Start agent" launches: the bound session's cwd when it bound, else the page's folder. */
  cwd: string;
  /** What the page may save itself; Start agent re-declares it. */
  writable: string[];
  bound_at: string;
}

export interface TellRequest {
  /** Idempotency key; becomes the batch id (and its single note action's id). */
  batch_id: string;
  pin_id: string;
  text: string;
  /** Optional structured context from the page, sent as compact JSON. */
  context?: unknown;
}

export interface StopInfo {
  at: string;
  /** Claude put the interrupted prompt back in the input box; it blocks idle delivery until cleared. */
  draft: boolean;
}

/** Batch status as shown: `orphaned` = claimed by a process that died before settling (uncertain). */
export type BatchStatusView = "queued" | "attempting" | "orphaned" | "uncertain" | "transport_sent" | "seen" | "acted" | "cancelled";

export interface DeliverySummary {
  /** Current-run batches not yet handed over (including ones parked behind a Pause). */
  queued: number;
  /** Why queued work hasn't gone out, in plain words; null when nothing waits. */
  waiting: string | null;
  /** A head batch holding the queue: in flight, unconfirmed, orphaned, or parked by a Pause. */
  held: { batch_id: string; reason: "attempting" | "uncertain" | "orphaned" | "paused"; since: string; detail: string | null } | null;
  /** Sent batches the model hasn't marked seen for 2+ minutes (quiet warning; Retry offered). */
  unseen: number;
  /** Batches sent to an earlier run that never went out: they need a retarget or cancel. */
  old_run: number;
}

export interface BatchView {
  batch_id: string;
  kind: "send" | "pause";
  /** `page`: a tell from the session's page (no tray). */
  via: "page" | null;
  run: string;
  current_run: boolean;
  status: BatchStatusView;
  created_at: string;
  /** The exact frozen text the agent receives. */
  text: string;
  actions: { action_id: string; type: string; item_id: string | null; acted: { outcome: string; note: string | null } | null }[];
  attempts: { attempt_id: string; route: "post_tool_use" | "stop" | "idle_submit"; claimed_at: string; outcome: string | null; detail: string | null; settled_at: string | null }[];
  corroborated_at: string | null;
  seen_at: string | null;
  cancelled: { reason: string; by: "human" | "auto"; at: string } | null;
  /** The human may Retry: uncertain, orphaned, or sent and unseen for 2+ minutes. May duplicate. */
  retryable: boolean;
  /** One quiet factual line (why it is stuck / unseen); null when all is well. */
  warning: string | null;
}

export interface ActivityEntry {
  seq: number;
  ts: string;
  type: string;
  hook: string | null;
  tool: string | null;
  paths: string[];
  detail: string | null;
}

export interface SessionsResponse {
  epoch: string;
  cursor: number;
  sessions: SessionView[];
  terminals: TerminalInfo[];
  pins: PinView[];
  /** Origin of the page listener (the frame-src the UI may embed). */
  page_origin: string;
}

export interface SessionDetailResponse {
  session: SessionView;
  activity: ActivityEntry[];
  /** Newest first. */
  batches: BatchView[];
  work: WorkView;
  tray: TrayView;
}

/** What the agent declared (brief, progress, items, handover), as folded from the journal. */
export interface WorkView {
  brief: BriefState | null;
  progress: ProgressState | null;
  /** In the order the agent first posted them. `actionable` = needs the human (plan §8.3). */
  items: (ItemState & { actionable: boolean })[];
  handover: HandoverState | null;
}

/** Staged actions only: Pause bypasses the tray. */
export type TrayAction = Exclude<BatchAction, { type: "pause" }>;

/** A session's send tray (plan §9.1): staged actions, persisted, sent only by an explicit Send. */
export interface TrayView {
  revision: number;
  /** The id this tray will be sent as (the HTTP idempotency key); null while empty. */
  batch_id: string | null;
  actions: { action: TrayAction; label: string; conflict: string | null }[];
  /** Exactly the text `batch.created` will freeze (null while empty). */
  preview: string | null;
  preview_bytes: number;
  /** Why Send would be refused right now (conflicts, no live run); null = sendable. */
  blocked: string | null;
}

export interface TrayPutRequest {
  expected_revision: number;
  actions: TrayAction[];
}

export interface SendRequest {
  batch_id: string;
  tray_revision: number;
}

export interface LaunchOptions {
  models: string[];
  efforts: string[];
  claude_version: string | null;
}

export interface LaunchRequest {
  request_id: string;
  cwd: string;
  model?: string;
  effort?: string;
  prompt?: string;
}

export interface LaunchResponse {
  terminal_id: string;
}

/** SSE `data` payloads; the SSE `id` is `<epoch>:<cursor>`. */
export type StreamEvent =
  | { type: "session"; session: SessionView }
  | { type: "session_removed"; id: string }
  | { type: "terminal"; terminal: TerminalInfo }
  /** The whole pin list, whenever it changes. */
  | { type: "pins"; pins: PinView[] }
  /** A file in a pinned page's folder changed (debounced): the host reloads that frame. */
  | { type: "page"; pin_id: string }
  | { type: "resync_required"; epoch: string };

/** Browser ⇄ daemon terminal WebSocket frames (JSON text). */
export type WsClientFrame =
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "control"; action: "acquire" | "release" | "takeover" };

export type WsServerFrame =
  | { t: "hello"; viewer_id: string; terminal: TerminalInfo }
  | { t: "snapshot_begin"; stream_epoch: string; seq: number; cols: number; rows: number }
  | { t: "snapshot_chunk"; data_b64: string }
  | { t: "snapshot_end"; seq: number }
  | { t: "output"; stream_epoch: string; seq: number; data_b64: string }
  | { t: "resize"; seq: number; cols: number; rows: number }
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "control"; writer: string | null }
  | { t: "error"; code: string; message: string };
