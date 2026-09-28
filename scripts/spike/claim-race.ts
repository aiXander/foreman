// Gate 2 duplicate-claim stress (no model): 8 processes race claim→settle over 100 queued batches
// on one queue, as hook and daemon consumers would. Every batch must be claimed exactly once.
// Usage: bun scripts/spike/claim-race.ts
import { rmSync } from "node:fs";
import { join } from "node:path";
process.env.FOREMAN_HOME = "/tmp/fh";
const { claimNext, enqueue, history, settle } = await import("./queue");
const native = "claim-race";

if (process.argv[2] === "child") {
  let n = 0;
  for (let idle = 0; idle < 200; ) {
    let c = null;
    try {
      c = claimNext(native, n % 2 ? "Stop" : "idle_submit", 2000);
    } catch {}
    if (!c) {
      idle++;
      await Bun.sleep(2);
      continue;
    }
    idle = 0;
    n++;
    settle(native, c, true);
  }
  process.exit(0);
}

rmSync(join("/tmp/fh/spike/queue", `${native}.jsonl`), { force: true });
const ids = Array.from({ length: 100 }, () => enqueue(native, "x"));
const kids = Array.from({ length: 8 }, () => Bun.spawn(["bun", import.meta.path, "child"], { stdout: "inherit", stderr: "inherit" }));
await Promise.all(kids.map((k) => k.exited));
const claims = new Map<string, number>();
const pids = new Set<number>();
for (const r of history(native) as any[]) if (r.type === "claimed") (claims.set(r.batch_id, (claims.get(r.batch_id) ?? 0) + 1), pids.add(r.pid));
const dup = [...claims.values()].filter((n) => n > 1).length;
const missing = ids.filter((id) => !claims.has(id)).length;
console.log(`${ids.length} batches, ${[...claims.values()].reduce((a, b) => a + b, 0)} claims by ${pids.size} processes, duplicates=${dup}, unclaimed=${missing}`);
process.exit(dup || missing ? 1 : 0);
