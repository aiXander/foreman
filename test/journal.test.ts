import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, JournalError } from "../src/shared/journal";
import { acquireLock, LockTimeout } from "../src/shared/lock";

let dir: string;
let j: Journal;
const draft = (n: number) => ({ type: "t", payload: { n }, fields: { session: "s" } });
const opts = { lockTimeoutMs: 500, durable: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foreman-journal-"));
  j = new Journal(join(dir, "events.jsonl"), join(dir, ".write-lock"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("journal", () => {
  test("assigns contiguous seq across appends and reads complete lines back", () => {
    j.append([draft(1), draft(2)], opts);
    j.append([draft(3)], opts);
    expect(j.readAll().map((e) => [e.seq, (e.payload as any).n])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  test("a torn final line is moved aside and never acknowledged; seq continues from the last complete record", () => {
    j.append([draft(1)], opts);
    appendFileSync(j.file, '{"v":1,"seq":2,"half');
    expect(j.readFrom(0).events).toHaveLength(1); // readers skip the partial line
    const r = j.append([draft(2)], opts);
    expect(r.events[0]!.seq).toBe(2);
    expect(j.readAll().map((e) => e.seq)).toEqual([1, 2]);
    expect(readdirSync(dir).some((f) => f.includes(".torn-"))).toBe(true);
  });

  test("interior corruption makes the journal read-only instead of silently skipping records", () => {
    j.append([draft(1)], opts);
    appendFileSync(j.file, "not json\n");
    expect(() => j.append([draft(2)], opts)).toThrow(JournalError);
    expect(() => j.readAll()).toThrow(/unparseable/);
  });

  test("request_id replays the original result and rejects a different payload", () => {
    const id = crypto.randomUUID();
    const first = j.append([draft(1)], { ...opts, requestId: id });
    const again = j.append([draft(1)], { ...opts, requestId: id });
    expect(again.replayed).toBe(true);
    expect(again.events[0]!.id).toBe(first.events[0]!.id);
    expect(j.readAll()).toHaveLength(1);
    expect(() => j.append([draft(9)], { ...opts, requestId: id })).toThrow(/different payload/);
  });

  test("oversized records are refused with LIMIT", () => {
    expect(() => j.append([{ type: "t", payload: { s: "x".repeat(70_000) }, fields: {} }], opts)).toThrow(/exceeds/);
    expect(existsSync(j.file) ? readFileSync(j.file, "utf8") : "").toBe("");
  });

  test("concurrent writer processes never duplicate or skip a seq", async () => {
    const script = join(dir, "writer.ts");
    writeFileSync(
      script,
      `import { Journal } from ${JSON.stringify(join(import.meta.dir, "../src/shared/journal"))};
       const j = new Journal(process.argv[2], process.argv[3]);
       for (let i = 0; i < 40; i++) j.append([{ type: "t", payload: { w: process.argv[4], i }, fields: {} }], { lockTimeoutMs: 5000, durable: false });`,
    );
    const procs = [0, 1, 2, 3].map((w) => Bun.spawn(["bun", script, j.file, j.lockDir, String(w)]));
    await Promise.all(procs.map((p) => p.exited));
    const seqs = j.readAll().map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 160 }, (_, i) => i + 1));
  });
});

describe("lock", () => {
  test("a live owner blocks until timeout", () => {
    const lockDir = join(dir, "l");
    const held = acquireLock(lockDir, 100);
    expect(() => acquireLock(lockDir, 50)).toThrow(LockTimeout);
    held.release();
    acquireLock(lockDir, 50).release();
  });

  test("a dead owner's lock is broken; age alone never breaks a live one", async () => {
    const lockDir = join(dir, "l");
    const p = Bun.spawn(["sleep", "0"]);
    await p.exited;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: p.pid, start: "Thu Jan  1 00:00:00 1970", token: "dead", at: "2000-01-01T00:00:00Z" }));
    acquireLock(lockDir, 500).release();

    // Ancient timestamp, but the owner (this process) is alive: must not be broken.
    const live = acquireLock(lockDir, 100);
    const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ ...owner, at: "2000-01-01T00:00:00Z" }));
    expect(() => acquireLock(lockDir, 300)).toThrow(LockTimeout);
    live.release();
  });
});
