// Cross-process writer lock: an atomic directory whose owner.json names PID + process start.
// The directory is fully built under a temp name, then renamed into place, so a lock never
// exists without its owner. A lock is broken only when its owner is provably dead — never on age.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { liveness, selfStart } from "./proc";

export class LockTimeout extends Error {
  code = "LOCK_TIMEOUT" as const;
}

interface Owner {
  pid: number;
  start: string;
  token: string;
  at: string;
}

function readOwner(lockDir: string): Owner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function tryCreate(lockDir: string, owner: Owner): boolean {
  const tmp = `${lockDir}.tmp-${owner.token}`;
  mkdirSync(tmp, { mode: 0o700 });
  writeFileSync(join(tmp, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  try {
    renameSync(tmp, lockDir);
    return true;
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    if (e?.code === "ENOTEMPTY" || e?.code === "EEXIST") return false;
    throw e;
  }
}

/** Remove a lock whose owner is dead. Only the breaker that wins the rename removes it. */
function breakIfDead(lockDir: string): boolean {
  const owner = readOwner(lockDir);
  if (!owner) return false; // unreadable owner: never guess
  if (liveness(owner.pid, owner.start) !== "dead") return false;
  const graveyard = `${lockDir}.stale-${crypto.randomUUID()}`;
  try {
    renameSync(lockDir, graveyard);
  } catch {
    return false; // someone else broke or released it
  }
  const moved = readOwner(graveyard);
  if (moved?.token !== owner.token) {
    // We raced and moved a fresh, live lock. Put it back if the slot is still free.
    try {
      renameSync(graveyard, lockDir);
    } catch {}
    return false;
  }
  rmSync(graveyard, { recursive: true, force: true });
  return true;
}

export interface Lock {
  release(): void;
}

export function acquireLock(lockDir: string, timeoutMs: number): Lock {
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  const owner: Owner = { pid: process.pid, start: selfStart(), token: crypto.randomUUID(), at: new Date().toISOString() };
  const deadline = performance.now() + timeoutMs;
  let nextOwnerCheck = 0;
  for (;;) {
    if (tryCreate(lockDir, owner)) {
      return {
        release() {
          if (readOwner(lockDir)?.token !== owner.token) return;
          // Never rm the lock in place: a half-deleted (empty) lock dir can be replaced by
          // another writer's rename, and the recursive rm would then delete *their* lock.
          const graveyard = `${lockDir}.released-${owner.token}`;
          renameSync(lockDir, graveyard);
          rmSync(graveyard, { recursive: true, force: true });
        },
      };
    }
    // Checking liveness spawns `ps`, so do it at most every 200 ms, not on every spin.
    if (performance.now() >= nextOwnerCheck) {
      nextOwnerCheck = performance.now() + 200;
      if (breakIfDead(lockDir)) continue;
    }
    if (performance.now() >= deadline) throw new LockTimeout(`lock busy: ${lockDir}`);
    Bun.sleepSync(3);
  }
}

export function withLock<T>(lockDir: string, timeoutMs: number, fn: () => T): T {
  const lock = acquireLock(lockDir, timeoutMs);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
