import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeRegistry } from "../src/shared/native";
import { processStart } from "../src/shared/proc";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "foreman-native-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (pid: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: "/p", name: `n-${pid}`, status: "idle", ...extra });

test("liveness compares PID + process start; missing start is unknown; .key and junk are ignored", async () => {
  const dead = Bun.spawn(["sleep", "0"]);
  await dead.exited;
  writeFileSync(join(dir, `${dead.pid}.json`), row(dead.pid, { procStart: "Thu Jan  1 00:00:00 1970" }));
  writeFileSync(join(dir, `${process.pid}.json`), row(process.pid, { procStart: processStart(process.pid) }));
  writeFileSync(join(dir, "1.json"), row(1)); // launchd exists, but no procStart: unknown, not alive
  writeFileSync(join(dir, `${process.pid}.reused.json`), JSON.stringify({ pid: process.pid, sessionId: "reused", procStart: "Mon Jan  1 00:00:00 2001" }));
  writeFileSync(join(dir, `${process.pid}.abc.key`), "SECRET");
  writeFileSync(join(dir, "broken.json"), "{");

  const rows = Object.fromEntries(readNativeRegistry(dir).map((r) => [r.session_id, r]));
  expect(Object.keys(rows).sort()).toEqual([`s-${dead.pid}`, `s-${process.pid}`, "s-1", "reused"].sort());
  expect(rows[`s-${dead.pid}`]!.live).toBe("dead");
  expect(rows[`s-${process.pid}`]).toMatchObject({ live: "alive", name: `n-${process.pid}`, status: "idle", cwd: "/p" });
  expect(rows["s-1"]!.live).toBe("unknown");
  expect(rows["reused"]).toMatchObject({ live: "dead", name: null, status: null }); // PID reused → not that process
});

test("missing directory yields no rows", () => {
  expect(readNativeRegistry(join(dir, "nope"))).toEqual([]);
});
