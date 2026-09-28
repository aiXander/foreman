// Session/run identity from Claude's SessionStart and SessionEnd hooks (§6.2). All identity
// changes happen under one global registration lock, so two hooks can never mint two Foreman
// sessions for one conversation or bind one terminal twice. The journal is the truth; the
// by-native / by-terminal maps and the manifest are rebuildable caches written after it.
import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { RunSource } from "./events";
import { withLock } from "./lock";
import { ensureDir, paths } from "./paths";
import { processStart } from "./proc";
import { projectRoot } from "./project";
import { foldJournal, type JournalState } from "./reducer";
import { appendSessionEvents, LOCK_TIMEOUT, lookupNative, readJson, sessionJournal, writeJsonAtomic, writeManifest } from "./store";

export interface SessionStartInput {
  session_id: string;
  cwd: string;
  transcript_path?: string | null;
  source?: string | null;
  model?: unknown;
}

export interface SessionEndInput {
  session_id: string;
  reason?: string | null;
}

export interface Registration {
  session: string;
  run: string;
  target: string;
  created: boolean;
  compacted: boolean;
  mode: "managed" | "observed";
  source: string;
}

/** SessionEnd shares a 1.5 s budget across all hooks; never wait out the full mutation timeout. */
const SESSION_END_LOCK_MS = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;
}

function modelName(m: unknown): string | null {
  const v = typeof m === "string" ? m : m && typeof m === "object" ? ((m as any).id ?? (m as any).display_name) : null;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

function currentState(session: string): JournalState | null {
  return foldJournal(sessionJournal(session).readAll());
}

/**
 * Corroborating process identity only: walk the hook's parent chain to the Claude process.
 * Never used for routing; null when not found.
 */
function findClaudeAncestor(startPid = process.ppid, maxHops = 5): { pid: number; start: string } | null {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const r = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const m = r.stdout.toString().trim().match(/^(\d+)\s+(.+)$/);
    if (!m) return null;
    if (basename(m[2]!.trim()).toLowerCase().includes("claude")) {
      const start = processStart(pid);
      return start ? { pid, start } : null;
    }
    pid = Number(m[1]);
  }
  return null;
}

type TerminalEntry = { session: string; run: string };

/** Retire `run` in `session` unless it already ended or is no longer that session's current run. */
function endRunIfCurrent(session: string, run: string, reason: string): void {
  const s = currentState(session);
  if (!s || s.run !== run || s.state === "dead") return;
  appendSessionEvents(session, run, "hook", [
    { type: "run.ended", payload: { reason, via: "hook", exit_code: null, signal: null } },
  ]);
}

export function registerSessionStart(input: SessionStartInput, env: Record<string, string | undefined> = process.env): Registration {
  if (typeof input.session_id !== "string" || !input.session_id.trim()) throw new Error("SessionStart without session_id");
  if (typeof input.cwd !== "string" || !input.cwd) throw new Error("SessionStart without cwd");
  const nativeId = input.session_id.trim().slice(0, 128);
  const parsedSource = RunSource.safeParse(input.source);
  const source = parsedSource.success ? parsedSource.data : "unknown";
  const terminalId = uuidOrNull(env.FOREMAN_TERMINAL_ID);
  const launchId = terminalId ? uuidOrNull(env.FOREMAN_LAUNCH_ID) : null;
  const claude = source === "compact" ? null : findClaudeAncestor();

  return withLock(paths.registrationLock(), LOCK_TIMEOUT.mutation, () => {
    ensureDir(paths.byNative());
    let session = lookupNative("claude", nativeId);
    let created = false;
    if (!session || !existsSync(paths.sessionJournal(session))) {
      session = crypto.randomUUID();
      created = true;
      const project = projectRoot(input.cwd);
      appendSessionEvents(session, null, "hook", [
        { type: "session.created", payload: { vendor: "claude", native_id: nativeId, project, cwd: input.cwd } },
      ]);
      writeFileSync(paths.byNativeEntry("claude", nativeId), session, { mode: 0o600 });
    }

    const state = currentState(session)!;
    let run: string;
    let target: string;
    let compacted = false;
    if (source === "compact" && state.run && state.target && state.state !== "dead") {
      // Compaction keeps identity; the event lets the (phase 2) contract re-injection be audited.
      run = state.run;
      target = state.target;
      compacted = true;
      appendSessionEvents(session, run, "hook", [{ type: "run.compacted", payload: { target } }]);
    } else {
      if (state.run && state.state !== "dead") {
        // Two incarnations claiming one conversation is a conflict, not a merge: retire the old one.
        appendSessionEvents(session, state.run, "hook", [
          { type: "run.ended", payload: { reason: "superseded", via: "hook", exit_code: null, signal: null } },
        ]);
      }
      run = crypto.randomUUID();
      target = crypto.randomUUID();
      ensureDir(paths.byTarget());
      writeFileSync(paths.byTargetEntry(target), session, { mode: 0o600 });
      appendSessionEvents(session, run, "hook", [
        {
          type: "run.started",
          payload: {
            target,
            source,
            mode: terminalId ? "managed" : "observed",
            terminal_id: terminalId,
            launch_id: launchId,
            model: modelName(input.model),
            transcript_path: typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path.slice(0, 4096) : null,
            claude_pid: claude?.pid ?? null,
            claude_start: claude?.start ?? null,
          },
        },
      ]);
    }

    if (terminalId) {
      ensureDir(paths.byTerminal());
      const prior = readJson<TerminalEntry>(paths.byTerminalEntry(terminalId));
      // In-TUI /clear or /resume moved this terminal to another conversation: retire the old route.
      if (prior && prior.session !== session) endRunIfCurrent(prior.session, prior.run, "rebound");
      writeJsonAtomic(paths.byTerminalEntry(terminalId), { session, run } satisfies TerminalEntry);
    }

    const after = currentState(session)!;
    writeManifest({
      session,
      vendor: "claude",
      native_id: nativeId,
      project: after.project,
      cwd: input.cwd,
      run,
      target,
      mode: after.mode,
      terminal_id: after.terminal_id,
      updated_at: new Date().toISOString(),
    });
    return { session, run, target, created, compacted, mode: after.mode, source };
  });
}

/** SessionEnd retires the current run. Returns false when the session is unknown or already ended. */
export function registerSessionEnd(input: SessionEndInput): boolean {
  const session = typeof input.session_id === "string" ? lookupNative("claude", input.session_id.trim()) : null;
  if (!session) return false;
  return withLock(paths.registrationLock(), SESSION_END_LOCK_MS, () => {
    const s = currentState(session);
    if (!s?.run || s.state === "dead") return false;
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 200) : "session_end";
    endRunIfCurrent(session, s.run, reason);
    return true;
  });
}
