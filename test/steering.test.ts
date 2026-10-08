// Human steering over HTTP (plan §9.1): the persisted send tray, Send (freeze + clear), Pause,
// batch cancel/retarget and decision review — real daemon, real journals, no ptyd, no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "foreman-steer-"));
process.env.FOREMAN_HOME = home;
process.env.FOREMAN_CLAUDE_SESSIONS_DIR = join(home, "no-claude-registry");

const { Auth, loadOrCreateSecret } = await import("../src/daemon/auth");
const { Projection } = await import("../src/daemon/projection");
const { PtydLink } = await import("../src/daemon/terminals");
const { Hub } = await import("../src/daemon/hub");
const { serve } = await import("../src/daemon/server");
const { Trays } = await import("../src/daemon/trays");
const { StopControl } = await import("../src/daemon/stopper");
const { Pins } = await import("../src/daemon/pins");
const { registerSessionStart } = await import("../src/shared/registration");
const { callTool } = await import("../src/shared/tools");
const { foldJournal } = await import("../src/shared/reducer");
const { sessionJournal, appendSessionEvents } = await import("../src/shared/store");
const { createBatch } = await import("../src/shared/delivery");
const { batchStatus } = await import("../src/shared/work");
const { paths } = await import("../src/shared/paths");

const port = 20000 + Math.floor(Math.random() * 20000);
const config = { version: 1 as const, bind: "127.0.0.1" as const, port, page_port: port + 1, extra_origins: [], claude_executable: "/usr/bin/true" };
let bearer: Record<string, string>;
let server: ReturnType<typeof serve>;
let projection: InstanceType<typeof Projection>;
let hub: InstanceType<typeof Hub>;
let ptyd: InstanceType<typeof PtydLink>;

beforeAll(async () => {
  const secret = loadOrCreateSecret();
  bearer = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  projection = new Projection();
  ptyd = new PtydLink();
  const trays = new Trays();
  hub = new Hub(projection, ptyd, null, trays);
  projection.start();
  await ptyd.start();
  hub.start();
  server = serve({ config, auth: new Auth(secret, config), hub, projection, ptyd, trays, stops: new StopControl(ptyd), pins: new Pins(`http://localhost:${port + 1}`) });
});

afterAll(() => {
  server.stop(true);
  hub.stop();
  ptyd.stop();
  projection.stop();
  rmSync(home, { recursive: true, force: true });
});

const req = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: bearer, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const detail = async (session: string) => {
  projection.refresh(session);
  hub.recompute();
  return (await req("GET", `/sessions/${session}`)).body;
};
const work = (session: string) => foldJournal(sessionJournal(session).readAll())!.work;

function setup(native: string) {
  const reg = registerSessionStart({ session_id: native, cwd: home, source: "startup" });
  const call = (tool: string, input: Record<string, unknown>) => callTool(tool, { target: reg.target, request_id: crypto.randomUUID(), ...input }, { source: "cli" }) as any;
  const common = { summary: "Self-contained summary.", impact: "high", reversibility: "costly", expected_revision: 0 };
  expect(
    call("foreman_ask", {
      ...common,
      id: "db",
      title: "Which database?",
      options: [
        { id: "sqlite", label: "SQLite", consequence: "One file." },
        { id: "pg", label: "Postgres", consequence: "A server." },
      ],
      default: "sqlite",
      policy: "park",
    }).ok,
  ).toBe(true);
  expect(call("foreman_post", { ...common, id: "cache", title: "Cache layer", body: { kind: "decision", chose: "LRU", alternatives: ["LFU"], why: "Simple." } }).ok).toBe(true);
  return { ...reg, call };
}

const answer = (option_id = "pg", item_revision = 1) => ({ type: "answer" as const, action_id: crypto.randomUUID(), item_id: "db", item_revision, option_id });
const note = (text: string) => ({ type: "note" as const, action_id: crypto.randomUUID(), text });

describe("tray", () => {
  test("staging persists with revisions; one staged action per item; the preview is exactly the frozen text", async () => {
    const s = setup("tray-1");
    const empty = (await detail(s.session)).tray;
    expect(empty).toMatchObject({ revision: 0, batch_id: null, actions: [], preview: null });

    const a1 = answer();
    const put = await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 0, actions: [a1, note("also add tests")] });
    expect(put.status).toBe(200);
    expect(put.body.tray.revision).toBe(1);
    expect(put.body.tray.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(put.body.tray.actions[0].label).toContain('option "Postgres"');

    // Stale revision → conflict; nothing changes.
    expect((await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 0, actions: [] })).status).toBe(409);
    // Two actions for one item → refused (the client replaces instead).
    expect((await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 1, actions: [a1, answer("sqlite")] })).status).toBe(400);
    // Pause is never staged.
    expect((await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 1, actions: [{ type: "pause", action_id: crypto.randomUUID() }] })).status).toBe(400);

    const d = await detail(s.session);
    expect(d.session.unsent).toBe(2);
    const tray = d.tray;
    const send = await req("POST", `/sessions/${s.session}/send`, { batch_id: tray.batch_id, tray_revision: tray.revision });
    expect(send.status).toBe(200);
    const w = work(s.session);
    expect(w.batches[tray.batch_id]!.text).toBe(tray.preview);
    const after = await detail(s.session);
    expect(after.tray).toMatchObject({ actions: [], batch_id: null, revision: 2 });
    expect(after.session.unsent).toBe(0);

    // An HTTP retry of the same Send is a replay: no second batch.
    const again = await req("POST", `/sessions/${s.session}/send`, { batch_id: tray.batch_id, tray_revision: tray.revision });
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(work(s.session).batch_order.length).toBe(1);
    // A staged action id that already went out can't be staged again.
    expect((await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 2, actions: [a1] })).status).toBe(409);
  });

  test("a stale item shows as a conflict in the tray and Send is refused without writing", async () => {
    const s = setup("tray-2");
    const put = await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 0, actions: [answer()] });
    // The agent revises its question after the human staged an answer.
    const q = work(s.session).items.db!;
    expect(s.call("foreman_ask", { id: "db", title: "Which database, really?", summary: q.summary, impact: q.impact, reversibility: q.reversibility, expected_revision: 1, options: (q.body as any).options, default: "sqlite", policy: "park" }).ok).toBe(true);
    const d = await detail(s.session);
    expect(d.tray.actions[0].conflict).toContain("changed since you staged this");
    expect(d.tray.blocked).toContain("no longer match");
    const send = await req("POST", `/sessions/${s.session}/send`, { batch_id: put.body.tray.batch_id, tray_revision: put.body.tray.revision });
    expect(send.status).toBe(409);
    expect(send.body.field).toBe(put.body.tray.actions[0].action.action_id);
    expect(work(s.session).batch_order.length).toBe(0);
    expect((await detail(s.session)).tray.actions.length).toBe(1); // still staged, for the human to fix
  });

  test("a Send that committed but crashed before clearing is recognised as sent (reconcile)", async () => {
    const s = setup("tray-3");
    const put = await req("PUT", `/sessions/${s.session}/tray`, { expected_revision: 0, actions: [note("one"), note("two")] });
    const t = put.body.tray;
    // Simulate the crash: the batch is durable, the tray clear never happened.
    createBatch(s.session, { batch_id: t.batch_id, run: s.run, kind: "send", actions: t.actions.map((a: any) => a.action) });
    const d = await detail(s.session);
    expect(d.tray.actions).toEqual([]);
    expect(d.tray.batch_id).toBeNull();
    const log = readFileSync(paths.uiJournal(), "utf8");
    expect(log).toContain(s.session);
  });
});

describe("pause, cancel, retarget, review", () => {
  test("Pause on an idle observed session is refused up front; mid-turn it queues ahead of sends", async () => {
    const s = setup("pause-1");
    const idle = await req("POST", `/sessions/${s.session}/pause`, { batch_id: crypto.randomUUID() });
    expect(idle.status).toBe(409);
    expect(idle.body.error).toContain("Already idle");
    expect(work(s.session).batch_order.length).toBe(0);

    appendSessionEvents(s.session, s.run, "hook", [{ type: "activity", payload: { hook: "UserPromptSubmit", tool: null, paths: [], notification: null, detail: null, agent_id: null } }]);
    await detail(s.session); // hub view now says working
    const send = createBatch(s.session, { batch_id: crypto.randomUUID(), run: s.run, kind: "send", actions: [note("later")] });
    const pause = await req("POST", `/sessions/${s.session}/pause`, { batch_id: crypto.randomUUID() });
    expect(pause.status).toBe(200);
    const w = work(s.session);
    expect(w.batches[pause.body.batch_id]!.kind).toBe("pause");
    expect(batchStatus(w.batches[send.batch.batch_id]!)).toBe("queued");
  });

  test("cancel works on a queued batch only; retarget moves an earlier run's send to the current run", async () => {
    const s = setup("retarget-1");
    const old = createBatch(s.session, { batch_id: crypto.randomUUID(), run: s.run, kind: "send", actions: [answer(), note("n")] }).batch;
    const other = createBatch(s.session, { batch_id: crypto.randomUUID(), run: s.run, kind: "send", actions: [note("cancel me")] }).batch;
    // The conversation restarts: both batches now belong to an earlier run.
    const resumed = registerSessionStart({ session_id: "retarget-1", cwd: home, source: "resume" });
    const d = await detail(s.session);
    expect(d.session.delivery.old_run).toBe(2);

    expect((await req("POST", `/sessions/${s.session}/batches/${other.batch_id}/cancel`, {})).status).toBe(200);
    expect(work(s.session).batches[other.batch_id]!.cancelled).toMatchObject({ by: "human" });

    const newId = crypto.randomUUID();
    const rt = await req("POST", `/sessions/${s.session}/batches/${old.batch_id}/retarget`, { batch_id: newId });
    expect(rt.status).toBe(200);
    const w = work(s.session);
    expect(w.batches[old.batch_id]!.cancelled?.reason).toContain(newId);
    expect(w.batches[newId]).toMatchObject({ run: resumed.run, kind: "send" });
    expect(w.batches[newId]!.actions.map((a) => a.action_id)).not.toContain(old.actions[0]!.action_id);
    expect(w.items.db!.human.map((h) => h.batch_id)).toEqual([newId]); // the cancelled original no longer counts as sent
    expect(w.batches[newId]!.text.replace(/\[action [^\]]+\]/g, "")).toBe(old.text.replace(/\[action [^\]]+\]/g, ""));
    // Idempotent per new batch id; a second retarget of the (now cancelled) old batch is refused.
    expect((await req("POST", `/sessions/${s.session}/batches/${old.batch_id}/retarget`, { batch_id: newId })).body.replayed).toBe(true);
    expect((await req("POST", `/sessions/${s.session}/batches/${old.batch_id}/retarget`, { batch_id: crypto.randomUUID() })).status).toBe(409);
    expect((await detail(s.session)).session.delivery.old_run).toBe(0);
  });

  test("retarget re-validates item revisions against the current state", async () => {
    const s = setup("retarget-2");
    const old = createBatch(s.session, { batch_id: crypto.randomUUID(), run: s.run, kind: "send", actions: [answer()] }).batch;
    const resumed = registerSessionStart({ session_id: "retarget-2", cwd: home, source: "resume" });
    const q = work(s.session).items.db!;
    const call = (tool: string, input: Record<string, unknown>) => callTool(tool, { target: resumed.target, request_id: crypto.randomUUID(), ...input }, { source: "cli" }) as any;
    expect(call("foreman_resolve", { id: "db", expected_revision: q.revision, outcome: "withdrawn", reason: "No longer needed." }).ok).toBe(true);
    const newId = crypto.randomUUID();
    const rt = await req("POST", `/sessions/${s.session}/batches/${old.batch_id}/retarget`, { batch_id: newId });
    expect(rt.status).toBe(409);
    expect(rt.body.error).toContain("changed since you staged this");
    const w = work(s.session);
    expect(w.batches[newId]).toBeUndefined();
    expect(w.batches[old.batch_id]!.cancelled).toBeNull();
  });

  test("marking a decision reviewed takes it off the needs-you list until its next revision", async () => {
    const s = setup("review-1");
    let d = await detail(s.session);
    expect(d.work.items.find((i: any) => i.id === "cache")).toMatchObject({ actionable: true, revision: 1 });
    expect((await req("POST", `/sessions/${s.session}/items/cache/reviewed`, { revision: 2 })).status).toBe(409);
    expect((await req("POST", `/sessions/${s.session}/items/cache/reviewed`, { revision: 1 })).status).toBe(200);
    d = await detail(s.session);
    expect(d.work.items.find((i: any) => i.id === "cache")).toMatchObject({ actionable: false, reviewed_revision: 1 });
    expect((await req("POST", `/sessions/${s.session}/items/db/reviewed`, { revision: 1 })).status).toBe(400); // questions aren't "reviewed"
  });
});
