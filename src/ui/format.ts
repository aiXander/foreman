import type { ActivityEntry, ActivityState, SessionMode, SessionView } from "../shared/api";
import { useEffect, useState } from "react";

export const stateLabel: Record<ActivityState, string> = {
  starting: "Starting",
  working: "Working",
  waiting_permission: "Needs permission",
  waiting_input: "Waiting for an answer",
  finishing: "Turn ended",
  idle: "Idle at prompt",
  dead: "Ended",
  unknown: "Unknown",
};

export const modeLabel: Record<SessionMode, string> = {
  managed: "managed",
  observed: "observed",
  registry_only: "registry only",
};

/** Attention order: blocking first, then waiting, working, the rest; ended last. */
const stateRank: Record<ActivityState, number> = {
  waiting_permission: 0,
  waiting_input: 1,
  working: 2,
  starting: 3,
  finishing: 4,
  idle: 5,
  unknown: 6,
  dead: 7,
};

export function sortSessions(list: SessionView[]): SessionView[] {
  return [...list].sort(
    (a, b) =>
      stateRank[a.state] - stateRank[b.state] ||
      (b.last_event_at ?? "").localeCompare(a.last_event_at ?? "") ||
      a.id.localeCompare(b.id),
  );
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function sessionTitle(s: SessionView): string {
  return s.name ?? `session ${s.native_id.slice(0, 8)}`;
}

/** Shorten a path under the project root to a relative one for display. */
export function relPath(path: string, root: string): string {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

export function relTime(ts: string | null, now: number): string | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function clock(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export function dateTime(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** Re-render every `ms` so relative times stay honest. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const hookText: Record<string, string> = {
  UserPromptSubmit: "Prompt submitted",
  PreToolUse: "Tool started",
  PostToolUse: "Tool finished",
  PostToolUseFailure: "Tool failed",
  PermissionRequest: "Permission requested",
  Stop: "Turn ended",
  StopFailure: "Turn ended with an error",
  SubagentStart: "Subagent started",
  SubagentStop: "Subagent finished",
};

const notificationText: Record<string, string> = {
  permission_prompt: "Waiting for permission",
  idle_prompt: "Idle at prompt",
  elicitation_dialog: "Asking a question",
  auth_success: "Signed in",
};

const typeText: Record<string, string> = {
  "run.started": "Run started",
  "run.ended": "Run ended",
  "run.compacted": "Context compacted",
  "session.created": "Session registered",
};

/** Plain-language line for one activity entry: [what happened, extra detail or null]. */
export function describeActivity(a: ActivityEntry): [string, string | null] {
  if (a.hook === "Notification") {
    const n = a.detail ? notificationText[a.detail] : undefined;
    return [n ?? "Notification", n ? null : a.detail];
  }
  if (a.hook) return [hookText[a.hook] ?? a.hook, a.detail];
  const t = typeText[a.type];
  // run.started/compacted details restate the type; keep only what adds information.
  if (a.type === "run.started") return [t!, a.detail?.replace(/^run started \((.*)\)$/, "$1") ?? null];
  if (a.type === "run.compacted") return [t!, null];
  return [t ?? a.type, a.detail];
}
