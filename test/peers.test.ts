// Per-project peers (plan §10) through the real reader against temp journals and a temp Claude
// registry: who counts as a peer, where names come from, the budget, and the contract block.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "../src/shared/contract";
import { buildPeers, contractPeers, readPeers, type Peer } from "../src/shared/peers";
import { processStart } from "../src/shared/proc";
import { foldJournal } from "../src/shared/reducer";
import { registerSessionEnd, registerSessionStart } from "../src/shared/registration";
import { sessionJournal } from "../src/shared/store";
import { callTool } from "../src/shared/tools";
import { useTempHome } from "./fixtures/home";

const tmp = useTempHome();
let registry = "";
beforeEach(() => {
  registry = mkdtempSync(join(tmpdir(), "foreman-reg-"));
  process.env.FOREMAN_CLAUDE_SESSIONS_DIR = registry;
});
afterEach(() => {
  delete process.env.FOREMAN_CLAUDE_SESSIONS_DIR;
  rmSync(registry, { recursive: true, force: true });
});

const start = (native: string, cwd = tmp.cwd()) => registerSessionStart({ session_id: native, cwd, source: "startup" }, {});
const call = (tool: string, input: Record<string, unknown>) =>
  callTool(tool, tool === "foreman_peers" ? input : { request_id: crypto.randomUUID(), ...input }, { source: "cli" }) as any;
const state = (session: string) => foldJournal(sessionJournal(session).readAll())!;
/** A registry row for a process that is verifiably alive (this test runner) or dead. */
const regRow = (native: string, cwd: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(registry, `${native}.json`), JSON.stringify({ pid: process.pid, procStart: processStart(process.pid), sessionId: native, cwd, name: `name-${native}`, status: "busy", ...extra }));

describe("readPeers", () => {
  test("same-project live sessions only: self, other projects and ended runs are excluded", () => {
    const a = start("a");
    const b = start("b");
    const ended = start("ended");
    registerSessionEnd({ session_id: "ended", reason: "exit" });
    const otherDir = mkdtempSync(join(tmpdir(), "foreman-other-"));
    start("elsewhere", otherDir);
    call("foreman_brief", { target: b.target, goal: "Add CSV export", done_when: "tests pass" });
    call("foreman_progress", { target: b.target, progress: 40, confidence: "med", now: "writing the endpoint" });

    const snap = readPeers({ session: a.session, native_id: "a", project: state(a.session).project }, 1000);
    expect(snap.peers.map((p) => p.session)).toEqual([b.session]);
    expect(snap.peers[0]).toMatchObject({ source: "foreman", goal: "Add CSV export", now: "writing the endpoint", progress: 40, name: null });
    expect(snap.unread).toBe(0);
    expect(ended.session).not.toBe(b.session);
    rmSync(otherDir, { recursive: true, force: true });
  });

  test("names come only from a live registry row; registry-only sessions appear without a card; dead rows drop the peer", () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");
    regRow("b", tmp.cwd());
    regRow("c", tmp.cwd(), { procStart: "Thu Jan  1 00:00:00 1970" }); // PID reused → dead
    regRow("plain", tmp.cwd(), { status: "idle" }); // no plugin, same project
    regRow("far", "/somewhere/else");

    const snap = readPeers({ session: a.session, native_id: "a", project: state(a.session).project }, 1000);
    const by = Object.fromEntries(snap.peers.map((p) => [p.native_id, p]));
    expect(Object.keys(by).sort()).toEqual(["b", "plain"]);
    expect(by.b).toMatchObject({ session: b.session, name: "name-b", live: "alive" });
    expect(by.plain).toMatchObject({ session: null, source: "registry", name: "name-plain", state: "idle", goal: null });
    expect(c.session).toBeTruthy();
  });

  test("an exhausted budget counts unread sessions instead of guessing, and never shows them as registry-only", () => {
    const a = start("a");
    start("b");
    regRow("b", tmp.cwd());
    const snap = readPeers({ session: a.session, native_id: "a", project: state(a.session).project }, -1);
    expect(snap.peers).toEqual([]);
    expect(snap.unread).toBe(1);
    expect(contractPeers(snap)).toContain("+1 more not shown (some could not be read in time)");
  });
});

describe("buildPeers", () => {
  test("no evidence for 10 min and no verified process reads as unknown; active known peers sort first", () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");
    const now = Date.now();
    const old = { ...state(b.session), claude_pid: null, last_event_at: new Date(now - 11 * 60_000).toISOString(), state: "working" as const };
    const fresh = { ...state(c.session), claude_pid: null };
    const rows = [{ pid: process.pid, session_id: "c", cwd: tmp.cwd(), name: "cc", status: "busy", updated_at: now, started_at: null, proc_start: null, version: null, kind: null, live: "alive" as const }];
    const peers = buildPeers({ session: a.session, native_id: "a", project: old.project }, [old, fresh], rows, (x) => x, now);
    expect(peers.map((p) => [p.native_id, p.state])).toEqual([
      ["c", fresh.state],
      ["b", "unknown"],
    ]);
  });
});

describe("contract block", () => {
  const peer = (i: number, goal = `goal ${i}`): Peer => ({ session: `s${i}`, native_id: `n${i}`, name: `peer-${i}`, source: "foreman", mode: "managed", state: "working", live: "alive", goal, now: "testing", progress: 10, phase: null, updated_at: null });

  test("at most 5 peers and 1,200 characters, with a truncation count and the foreman_peers pointer", () => {
    const block = contractPeers({ project: "/p", peers: Array.from({ length: 8 }, (_, i) => peer(i, "x".repeat(100))), unread: 0 })!;
    expect(block.length).toBeLessThanOrEqual(1200);
    expect(block.match(/^- "peer-/gm)).toHaveLength(5);
    expect(block).toContain("+3 more not shown");
    expect(block).toContain("foreman_peers");
    const long = contractPeers({ project: "/p", peers: Array.from({ length: 5 }, (_, i) => peer(i, "y".repeat(400))), unread: 0 })!;
    expect(long.length).toBeLessThanOrEqual(1200);
    expect(long).toMatch(/\+\d+ more not shown/);
  });

  test("no peers → no block; the contract carries the block when there is one", () => {
    expect(contractPeers({ project: "/p", peers: [], unread: 0 })).toBeNull();
    const text = buildContract({ target: crypto.randomUUID(), mode: "managed", source: "startup", tools: ["foreman_peers"], peers: contractPeers({ project: "/p", peers: [peer(1)], unread: 0 }) });
    expect(text).toContain('- "peer-1" — working; goal: goal 1; now: testing');
    expect(text).toContain("mcp__plugin_foreman_foreman__foreman_peers");
  });
});

describe("foreman_peers tool", () => {
  test("pages with limit/cursor and validates the caller's target", () => {
    const a = start("a");
    const others = ["b", "c", "d"].map((n) => start(n));
    for (const o of others) call("foreman_brief", { target: o.target, goal: `goal of ${o.session.slice(0, 4)}`, done_when: "done" });
    const first = call("foreman_peers", { target: a.target, limit: 2 });
    expect(first).toMatchObject({ ok: true });
    expect(first.result.peers).toHaveLength(2);
    const second = call("foreman_peers", { target: a.target, limit: 2, cursor: first.result.next_cursor });
    expect(second.result.peers).toHaveLength(1);
    expect(second.result.next_cursor).toBeNull();
    expect([...first.result.peers, ...second.result.peers].map((p: any) => p.goal).sort()).toEqual(others.map((o) => `goal of ${o.session.slice(0, 4)}`).sort());
    expect(call("foreman_peers", { target: crypto.randomUUID() }).code).toBe("NOT_REGISTERED");
  });
});
