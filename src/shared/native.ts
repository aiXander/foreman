// Read-only view of Claude Code's own session registry (~/.claude/sessions/<pid>.json).
// Private format: every field is optional, only `*.json` is ever read (never `.key` files or
// messaging sockets), and a surviving file is never proof of life — liveness compares
// PID + process start. Names are display/address hints, never keys.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { liveness, processStarts, type Liveness } from "./proc";

export interface NativeRow {
  pid: number;
  session_id: string;
  cwd: string;
  name: string | null;
  status: "busy" | "idle" | string | null;
  updated_at: number | null;
  started_at: number | null;
  proc_start: string | null;
  version: string | null;
  kind: string | null;
  live: Liveness;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function nativeSessionsDir(): string {
  return process.env.FOREMAN_CLAUDE_SESSIONS_DIR || join(homedir(), ".claude", "sessions");
}

export function readNativeRegistry(dir = nativeSessionsDir()): NativeRow[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: Omit<NativeRow, "live">[] = [];
  for (const f of files) {
    let d: any;
    try {
      d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // mid-write or foreign file: skip, next scan picks it up
    }
    const pid = num(d?.pid);
    const session_id = str(d?.sessionId);
    if (!pid || !Number.isInteger(pid) || pid <= 0 || !session_id) continue;
    rows.push({
      pid,
      session_id,
      cwd: str(d.cwd) ?? "",
      name: str(d.name),
      status: str(d.status),
      updated_at: num(d.updatedAt),
      started_at: num(d.startedAt),
      proc_start: str(d.procStart),
      version: str(d.version),
      kind: str(d.kind),
    });
  }
  const starts = processStarts(rows.map((r) => r.pid));
  return rows.map((r) => ({ ...r, live: liveness(r.pid, r.proc_start, starts) }));
}
