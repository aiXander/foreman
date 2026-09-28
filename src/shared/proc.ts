// Process identity = PID + process-start time. A PID alone is reused by the OS, so
// liveness claims always compare the start time too. The format is `TZ=UTC ps -o lstart=`,
// which is byte-identical to Claude's own registry `procStart` field.

export type Liveness = "alive" | "dead" | "unknown";

const cache = new Map<number, string | null>();

/** Start-time identity for many PIDs in one `ps` call. Missing PIDs map to null. */
export function processStarts(pids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const valid = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (valid.length === 0) return out;
  for (const p of valid) out.set(p, null);
  try {
    const r = Bun.spawnSync(["ps", "-o", "pid=,lstart=", "-p", valid.join(",")], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdout: "pipe",
      stderr: "ignore",
    });
    for (const line of r.stdout.toString().split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) out.set(Number(m[1]), m[2]!.trim());
    }
  } catch {
    for (const p of valid) out.delete(p); // ps unavailable: unknown, not dead
  }
  return out;
}

export function processStart(pid: number): string | null {
  return processStarts([pid]).get(pid) ?? null;
}

/** This process's own identity, computed once. */
export function selfStart(): string {
  if (!cache.has(process.pid)) cache.set(process.pid, processStart(process.pid));
  return cache.get(process.pid) ?? "unknown";
}

/** kill(pid, 0): ESRCH = dead, EPERM = exists but not ours (alive), anything else unknown. */
function signalProbe(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e: any) {
    if (e?.code === "ESRCH") return "dead";
    if (e?.code === "EPERM") return "alive";
    return "unknown";
  }
}

/**
 * Is (pid, start) still the same live process? A mismatched start time means the PID was
 * reused: dead. A missing expected start means we can only say the PID exists.
 */
export function liveness(pid: number, expectedStart?: string | null, starts?: Map<number, string | null>): Liveness {
  const probe = signalProbe(pid);
  if (probe !== "alive") return probe;
  if (!expectedStart) return "unknown";
  const actual = starts ? starts.get(pid) : processStart(pid);
  if (actual === undefined) return "unknown";
  if (actual === null) return "dead";
  return actual === expectedStart ? "alive" : "dead";
}
