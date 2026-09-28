// The daemon idle worker (plan §9.2 route 3) end to end: a registered managed session whose ptyd
// terminal runs the fake Claude input box (test/fixtures/fake-claude.ts). Real journal, real ptyd
// socket, real projection; no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PtyClient as PtyClientType } from "../src/shared/ptyclient";

const dir = mkdtempSync("/tmp/fm-idle-"); // short: the ptyd socket path is capped at 103 bytes
process.env.FOREMAN_HOME = dir;
process.env.FOREMAN_CLAUDE_SESSIONS_DIR = join(dir, "no-claude-registry");

const { ensureHome, paths } = await import("../src/shared/paths");
const { startPtyd } = await import("../src/ptyd/server");
const { PtyClient } = await import("../src/shared/ptyclient");
const { b64 } = await import("../src/shared/ptyproto");
const { Projection } = await import("../src/daemon/projection");
const { PtydLink } = await import("../src/daemon/terminals");
const { IdleWorker } = await import("../src/daemon/idle-worker");
const { deliverySummary } = await import("../src/daemon/delivery-view");
const { StopControl } = await import("../src/daemon/stopper");
const { createBatch } = await import("../src/shared/delivery");
const { registerSessionStart } = await import("../src/shared/registration");
const { sessionJournal } = await import("../src/shared/store");
const { foldJournal } = await import("../src/shared/reducer");
const { batchStatus } = await import("../src/shared/work");

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
let server: Awaited<ReturnType<typeof startPtyd>>;
let cli: PtyClientType;
let projection: InstanceType<typeof Projection>;
let link: InstanceType<typeof PtydLink>;
let worker: InstanceType<typeof IdleWorker>;

beforeAll(async () => {
  ensureHome();
  server = await startPtyd({ socket: paths.ptydSock(), writeRecord: false });
  cli = await PtyClient.connect({ client: "cli" });
  projection = new Projection();
  link = new PtydLink();
  worker = new IdleWorker(projection, link);
  projection.start();
  await link.start();
  worker.start();
});

afterAll(() => {
  worker.stop();
  link.stop();
  projection.stop();
  cli.close();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(fn: () => T | null | false | undefined | Promise<T | null | false | undefined>, label: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

/** A managed session registered by its SessionStart, routed (bound) to its fake terminal. */
async function managed(mode: "normal" | "working" = "normal") {
  const record = join(dir, `${crypto.randomUUID()}.jsonl`);
  const { terminal } = await cli.request<{ terminal: { terminal_id: string } }>({
    op: "create",
    request_id: crypto.randomUUID(),
    cwd: dir,
    argv: [process.execPath, FAKE, record, mode],
    cols: 80,
    rows: 24,
  });
  const tid = terminal.terminal_id;
  const reg = registerSessionStart({ session_id: `n-${crypto.randomUUID()}`, cwd: dir, source: "startup" }, { FOREMAN_TERMINAL_ID: tid });
  projection.refresh(reg.session);
  await link.syncBindings(projection.states());
  await until(() => link.terminals.get(tid)?.target === reg.target && link.terminals.get(tid)?.progress === (mode === "normal" ? "idle" : "busy"), "bound");
  const viewer = crypto.randomUUID();
  await cli.request({ op: "attach", terminal_id: tid, viewer_id: viewer });
  return {
    ...reg,
    tid,
    records: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    send: (kind: "send" | "pause" = "send", text = "please run the tests") => {
      const batch_id = crypto.randomUUID();
      createBatch(reg.session, { batch_id, run: reg.run, kind, actions: [kind === "pause" ? { type: "pause", action_id: crypto.randomUUID() } : { type: "note", action_id: crypto.randomUUID(), text }] });
      projection.refresh(reg.session);
      return batch_id;
    },
    state: () => foldJournal(sessionJournal(reg.session).readAll())!,
    control: (action: "acquire" | "release") => cli.request({ op: "control", terminal_id: tid, viewer_id: viewer, action }),
    type: async (s: string) => {
      await cli.request({ op: "control", terminal_id: tid, viewer_id: viewer, action: "acquire" });
      await cli.request({ op: "write", terminal_id: tid, viewer_id: viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode(s)) });
      await cli.request({ op: "control", terminal_id: tid, viewer_id: viewer, action: "release" });
    },
  };
}

describe("idle worker", () => {
  test("types a queued batch into the blank idle prompt as one new turn: claim, submit, settle", async () => {
    const m = await managed();
    const b = m.send("send", "please run the tests");
    const sub = await until(() => m.records().find((r) => r.submitted), "submitted turn");
    expect(sub.submitted).toStartWith(`[foreman batch ${b}] The human sent this from the Foreman UI`);
    expect(sub.submitted).toContain("Note: please run the tests");
    const st = await until(() => (batchStatus(m.state().work.batches[b]!) === "transport_sent" ? m.state() : null), "settled");
    expect(st.work.batches[b]!.attempts.map((a) => [a.route, a.outcome])).toEqual([["idle_submit", "transport_sent"]]);
    await Bun.sleep(1500);
    expect(m.records().filter((r) => r.submitted)).toHaveLength(1); // nothing re-sent
  }, 15_000);

  test("a draft or a held writer lease blocks it (reason shown, no claim); it goes out once cleared", async () => {
    const m = await managed();
    await m.type("half typed");
    const b = m.send();
    await until(() => worker.reason(m.session)?.includes("draft"), "draft reason");
    const view = () => deliverySummary(projection.get(m.session)!, "idle", link.terminals.get(m.tid)!, worker.reason(m.session));
    expect(view()).toMatchObject({ queued: 1, held: null });
    expect(view()!.waiting).toContain("draft");
    expect(m.state().work.batches[b]!.attempts).toHaveLength(0); // never claimed on a guess

    await m.type("\x15"); // clear the draft, but keep control
    await m.control("acquire");
    await until(() => worker.reason(m.session)?.includes("control"), "lease reason");
    expect(m.records().some((r) => r.submitted)).toBe(false);
    await m.control("release");
    await until(() => m.records().find((r) => r.submitted), "submitted after release");
  }, 15_000);

  test("a pause on an idle session is cancelled as moot, never typed; earlier sends stay parked", async () => {
    const m = await managed();
    await m.control("acquire"); // hold delivery while both are queued
    const early = m.send("send", "queued before pausing");
    const pause = m.send("pause");
    await m.control("release");
    await until(() => m.state().work.batches[pause]!.cancelled, "pause mooted");
    expect(m.state().work.batches[pause]!.cancelled).toMatchObject({ by: "auto", reason: "the session was already idle" });
    await Bun.sleep(1500);
    expect(batchStatus(m.state().work.batches[early]!)).toBe("queued");
    expect(m.records().some((r) => r.submitted)).toBe(false);
    const summary = deliverySummary(projection.get(m.session)!, "idle", link.terminals.get(m.tid)!, null);
    expect(summary?.held?.reason).toBe("paused");
  }, 15_000);
});

describe("Stop", () => {
  test("one ESC into a working turn; the prompt Claude put back is surfaced as a draft, and it blocks idle delivery", async () => {
    const stops = new StopControl(link);
    const m = await managed("working");
    expect(await stops.stop(m.state(), crypto.randomUUID())).toMatchObject({ draft: false });
    await until(() => stops.view(m.session)?.draft, "draft surfaced");
    expect(m.records().filter((r) => r.esc)).toHaveLength(1);
    // Idle now: a second Stop is refused by ptyd, never a second ESC.
    await expect(stops.stop(m.state(), crypto.randomUUID())).rejects.toThrow("not working");
    const b = m.send();
    await until(() => worker.reason(m.session)?.includes("draft"), "delivery blocked by the draft");
    expect(m.state().work.batches[b]!.attempts).toHaveLength(0);
    await m.type("\x15"); // the human clears it in the terminal
    await until(() => stops.view(m.session)?.draft === false, "draft cleared");
    await until(() => m.records().find((r) => r.submitted), "delivered after clearing");
    stops.stopAll();
  }, 20_000);

  test("observed sessions have no Stop", async () => {
    const stops = new StopControl(link);
    const reg = registerSessionStart({ session_id: `o-${crypto.randomUUID()}`, cwd: dir, source: "startup" }, {});
    await expect(stops.stop(foldJournal(sessionJournal(reg.session).readAll())!, crypto.randomUUID())).rejects.toThrow("Observed sessions have no Stop");
  });
});
