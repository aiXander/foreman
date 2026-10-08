// Compose what the UI sees from three independent evidence sources: the session journal (hooks),
// ptyd's terminal list (managed processes) and Claude's own registry (liveness, names).
// Missing evidence yields "unknown"; nothing here upgrades a guess to a fact.
import type { ActivityState, Capabilities, SessionPage, SessionView, StopInfo } from "../shared/api";
import type { NativeRow } from "../shared/native";
import { liveness } from "../shared/proc";
import type { TerminalInfo } from "../shared/ptyproto";
import type { JournalState } from "../shared/reducer";
import { deliverySummary } from "./delivery-view";

/** Daemon-side evidence beyond the journal: the idle worker's reason, the tray, the last Stop. */
export interface ViewExtras {
  workerReason?: string | null;
  unsent?: number;
  stop?: StopInfo | null;
  page?: SessionPage | null;
}

/** No hook evidence for this long, with no live process to vouch for it, reads as unknown. */
const STALE_MS = 10 * 60_000;

export function sessionView(
  s: JournalState,
  terminals: Map<string, TerminalInfo>,
  native: Map<string, NativeRow>,
  ptydUp: boolean,
  extra: ViewExtras = {},
  now = Date.now(),
): SessionView {
  const row = native.get(s.native_id) ?? null;
  const term = s.terminal_id ? terminals.get(s.terminal_id) ?? null : null;
  const managed = s.mode === "managed";

  let process: SessionView["process"];
  if (managed && term) process = term.state === "live" ? "alive" : "dead";
  else if (managed && ptydUp && s.terminal_id) process = "dead"; // ptyd is up and no longer knows it
  else if (row) process = row.live;
  else if (s.claude_pid) process = liveness(s.claude_pid, s.claude_start);
  else process = "unknown";

  let state: ActivityState = s.state;
  let endReason = s.end_reason;
  if (state !== "dead" && process === "dead") {
    state = "dead";
    endReason ??= term?.exit ? `process exited (${term.exit.signal ?? `code ${term.exit.code}`})` : "process gone";
  } else if (state !== "dead" && process !== "alive" && s.last_event_at && now - Date.parse(s.last_event_at) > STALE_MS) {
    state = "unknown";
  }

  return {
    id: s.session,
    vendor: "claude",
    native_id: s.native_id,
    project: s.project,
    cwd: s.cwd,
    mode: s.mode,
    capabilities: capabilities(s.mode, term),
    name: row?.name ?? null,
    run: s.run,
    terminal_id: s.terminal_id,
    terminal_state: term ? term.state : null,
    model: s.model ?? modelFromArgv(term?.argv),
    state,
    state_since: state === s.state ? s.state_since : null,
    last_event_at: s.last_event_at,
    current_tool: state === "dead" ? null : s.current_tool,
    recent_paths: s.recent_paths,
    tool_calls: s.tool_calls,
    tool_failures: s.tool_failures,
    failure_streak: s.failure_streak,
    subagents_active: state === "dead" ? 0 : s.subagents_active,
    process,
    started_at: s.started_at,
    ended_at: s.ended_at ?? (state === "dead" ? term?.exited_at ?? null : null),
    end_reason: state === "dead" ? endReason : null,
    last_seq: s.last_seq,
    delivery: deliverySummary(s, state, term, extra.workerReason ?? null, now),
    unsent: extra.unsent ?? 0,
    terminal_progress: managed && term?.state === "live" ? term.progress : null,
    stop: managed ? (extra.stop ?? null) : null,
    page: extra.page ?? null,
  };
}

/** SessionStart often omits the model; a managed launch's own argv is the next-best fact. */
function modelFromArgv(argv: string[] | undefined): string | null {
  const i = argv?.indexOf("--model") ?? -1;
  return i >= 0 ? (argv![i + 1] ?? null) : null;
}

function capabilities(mode: "managed" | "observed", term: TerminalInfo | null): Capabilities {
  if (mode === "managed") {
    const live = term?.state === "live";
    return {
      terminal: live,
      cards: true,
      steer: "full",
      label: live ? "Managed · Foreman terminal" : "Managed · terminal no longer running",
    };
  }
  return { terminal: false, cards: true, steer: "busy_only", label: "Observed · external terminal · hook telemetry only" };
}

/** A live Claude process that has no Foreman plugin registration: identity + coarse state only. */
export function registryOnlyView(row: NativeRow, project: string): SessionView {
  const state: ActivityState = row.status === "busy" ? "working" : row.status === "idle" ? "idle" : "unknown";
  const updated = row.updated_at ? new Date(row.updated_at).toISOString() : null;
  return {
    id: `reg-${row.session_id}`,
    vendor: "claude",
    native_id: row.session_id,
    project,
    cwd: row.cwd,
    mode: "registry_only",
    capabilities: { terminal: false, cards: false, steer: "none", label: "Discovered · Foreman plugin not loaded · registry state only" },
    name: row.name,
    run: null,
    terminal_id: null,
    terminal_state: null,
    model: null,
    state,
    state_since: updated,
    last_event_at: updated,
    current_tool: null,
    recent_paths: [],
    tool_calls: 0,
    tool_failures: 0,
    failure_streak: 0,
    subagents_active: 0,
    process: row.live,
    started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
    ended_at: null,
    end_reason: null,
    last_seq: 0,
    delivery: null,
    unsent: 0,
    terminal_progress: null,
    stop: null,
    page: null,
  };
}
