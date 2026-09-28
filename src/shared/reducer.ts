// Pure fold of one session journal into its journal-derived state. The daemon layers process,
// terminal and registry evidence on top (see daemon/view.ts); nothing here guesses liveness.
import type { ActivityEntry, ActivityState } from "./api";
import type { Stored } from "./journal";
import { emptyWork, reduceWork, WORK_EVENTS, type WorkState } from "./work";

const ACTIVITY_RING = 50;
const RECENT_PATHS = 8;

export interface JournalState {
  session: string;
  vendor: "claude";
  native_id: string;
  project: string;
  cwd: string;
  run: string | null;
  target: string | null;
  mode: "managed" | "observed";
  terminal_id: string | null;
  model: string | null;
  claude_pid: number | null;
  claude_start: string | null;
  state: ActivityState;
  state_since: string | null;
  last_event_at: string | null;
  current_tool: string | null;
  recent_paths: string[];
  tool_calls: number;
  tool_failures: number;
  failure_streak: number;
  subagents_active: number;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_seq: number;
  activity: ActivityEntry[];
  unknown_events: number;
  /** Declared work (brief/progress/items/handover) and human batches with their receipts. */
  work: WorkState;
}

function setState(s: JournalState, state: ActivityState, ts: string): void {
  if (s.state !== state) {
    s.state = state;
    s.state_since = ts;
  }
}

function pushActivity(s: JournalState, e: Stored, p: any): void {
  s.activity.push({
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    hook: p?.hook ?? null,
    tool: p?.tool ?? null,
    paths: p?.paths ?? [],
    detail: p?.detail ?? p?.reason ?? p?.notification ?? null,
  });
  if (s.activity.length > ACTIVITY_RING) s.activity.splice(0, s.activity.length - ACTIVITY_RING);
}

/** Returns a new state object when `prev` is null, otherwise mutates and returns `prev`. */
export function reduce(prev: JournalState | null, e: Stored): JournalState | null {
  const p = e.payload as any;
  if (e.type === "session.created") {
    return {
      session: e.session as string,
      vendor: "claude",
      native_id: p.native_id,
      project: p.project,
      cwd: p.cwd,
      run: null,
      target: null,
      mode: "observed",
      terminal_id: null,
      model: null,
      claude_pid: null,
      claude_start: null,
      state: "unknown",
      state_since: e.ts,
      last_event_at: e.ts,
      current_tool: null,
      recent_paths: [],
      tool_calls: 0,
      tool_failures: 0,
      failure_streak: 0,
      subagents_active: 0,
      started_at: e.ts,
      ended_at: null,
      end_reason: null,
      last_seq: e.seq,
      activity: [],
      unknown_events: 0,
      work: emptyWork(),
    };
  }
  const s = prev;
  if (!s) return null; // events before session.created: journal is malformed; caller reports
  s.last_seq = e.seq;
  s.last_event_at = e.ts;

  switch (e.type) {
    case "run.started":
      s.run = e.run as string;
      s.target = p.target;
      s.mode = p.mode;
      s.terminal_id = p.terminal_id;
      s.model = p.model ?? s.model;
      s.claude_pid = p.claude_pid;
      s.claude_start = p.claude_start;
      s.current_tool = null;
      s.failure_streak = 0;
      s.subagents_active = 0;
      s.ended_at = null;
      s.end_reason = null;
      setState(s, "starting", e.ts);
      pushActivity(s, e, { detail: `run started (${p.source}, ${p.mode})` });
      return s;
    case "run.compacted":
      pushActivity(s, e, { detail: "context compacted" });
      return s;
    case "run.ended":
      if (e.run !== s.run) return s;
      s.ended_at = e.ts;
      s.end_reason = p.reason;
      s.current_tool = null;
      s.subagents_active = 0;
      setState(s, "dead", e.ts);
      pushActivity(s, e, { detail: p.reason });
      return s;
    case "activity":
      break;
    default:
      if (WORK_EVENTS.has(e.type)) {
        reduceWork(s.work, e);
        return s;
      }
      s.unknown_events++;
      return s;
  }

  if (e.run !== s.run || s.state === "dead") return s; // telemetry from a retired run
  const sub = p.agent_id != null;
  for (const path of p.paths ?? []) {
    s.recent_paths = [path, ...s.recent_paths.filter((x) => x !== path)].slice(0, RECENT_PATHS);
  }
  switch (p.hook) {
    case "UserPromptSubmit":
      s.current_tool = null;
      setState(s, "working", e.ts);
      break;
    case "PreToolUse":
      if (!sub) s.current_tool = p.tool;
      setState(s, !sub && p.tool === "AskUserQuestion" ? "waiting_input" : "working", e.ts);
      break;
    case "PostToolUse":
    case "PostToolUseFailure": {
      const failed = p.hook === "PostToolUseFailure";
      s.tool_calls++;
      if (failed) s.tool_failures++;
      if (!sub) {
        s.current_tool = null;
        s.failure_streak = failed ? s.failure_streak + 1 : 0;
      }
      setState(s, "working", e.ts);
      break;
    }
    case "PermissionRequest":
      setState(s, "waiting_permission", e.ts);
      break;
    case "Notification":
      if (p.notification === "permission_prompt") setState(s, "waiting_permission", e.ts);
      else if (p.notification === "idle_prompt") setState(s, "idle", e.ts);
      else if (p.notification === "elicitation_dialog" || p.notification === "elicitation_url_dialog") setState(s, "waiting_input", e.ts);
      break;
    case "Stop":
    case "StopFailure":
      if (sub) break;
      s.current_tool = null;
      s.subagents_active = 0;
      setState(s, "finishing", e.ts);
      break;
    case "SubagentStart":
      s.subagents_active++;
      break;
    case "SubagentStop":
      s.subagents_active = Math.max(0, s.subagents_active - 1);
      break;
  }
  // Tool start/end pairs are too chatty for the card's activity list; keep the rest.
  if (p.hook !== "PreToolUse" && p.hook !== "PostToolUse") pushActivity(s, e, p);
  return s;
}

export function foldJournal(events: Stored[]): JournalState | null {
  let s: JournalState | null = null;
  for (const e of events) s = reduce(s, e);
  return s;
}
