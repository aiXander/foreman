// Project identity = canonical worktree root. Separate worktrees stay separate projects.
import { realpathSync } from "node:fs";

const cache = new Map<string, string>();

export function projectRoot(cwd: string): string {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let root: string;
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
    const top = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    root = realpathSync(top || cwd);
  } catch {
    root = cwd;
  }
  cache.set(cwd, root);
  return root;
}
