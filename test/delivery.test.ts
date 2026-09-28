// The delivery queue (plan §9.2): every consumer claims under the session lock before output;
// an unsettled or uncertain claim holds the queue; explicit Retry is the only way past uncertain.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { batchMarkers, claimNext, createBatch, hookContext, idleLead, onUserPrompt, retryable, retryBatch, settle, UNSEEN_RETRY_MS } from "../src/shared/delivery";
import { foldJournal } from "../src/shared/reducer";
import { registerSessionStart } from "../src/shared/registration";
import { sessionJournal } from "../src/shared/store";
import { callTool } from "../src/shared/tools";
import { batchStatus } from "../src/shared/work";
import { useTempHome } from "./fixtures/home";

const tmp = useTempHome();

const start = (native: string, source = "startup") => registerSessionStart({ session_id: native, cwd: tmp.cwd(), source });
const send = (session: string, run: string, text: string, kind: "send" | "pause" = "send") =>
  createBatch(session, {
    batch_id: crypto.randomUUID(),
    run,
    kind,
    actions: [kind === "pause" ? { type: "pause", action_id: crypto.randomUUID() } : { type: "note", action_id: crypto.randomUUID(), text }],
  }).batch.batch_id;
const statusOf = (session: string, id: string) => batchStatus(foldJournal(sessionJournal(session).readAll())!.work.batches[id]!);

describe("delivery queue", () => {
  test("FIFO; an in-flight claim holds the queue until it settles", () => {
    const { session, run } = start("q1");
    const a = send(session, run, "first");
    const b = send(session, run, "second");
    const c1 = claimNext(session, "post_tool_use")!;
    expect(c1.batch_id).toBe(a);
    expect(hookContext({ batch_id: a, text: c1.text }, "post_tool_use")).toStartWith(`[foreman batch ${a}]`);
    expect(claimNext(session, "stop")).toBeNull(); // another consumer can't overtake an unsettled claim
    settle(c1, "transport_sent");
    expect(claimNext(session, "stop")!.batch_id).toBe(b);
  });

  test("uncertain holds the queue until an explicit Retry, which makes a new attempt on the same batch", () => {
    const { session, run } = start("q2");
    const a = send(session, run, "typed but unconfirmed");
    send(session, run, "later");
    settle(claimNext(session, "idle_submit")!, "uncertain", "no echo");
    expect(statusOf(session, a)).toBe("uncertain");
    expect(claimNext(session, "post_tool_use")).toBeNull();
    retryBatch(session, a);
    const again = claimNext(session, "post_tool_use")!;
    expect(again.batch_id).toBe(a);
    expect(foldJournal(sessionJournal(session).readAll())!.work.batches[a]!.attempts).toHaveLength(2);
  });

  test("a definitive failure (nothing written) makes the batch eligible again", () => {
    const { session, run } = start("q3");
    const a = send(session, run, "x");
    settle(claimNext(session, "idle_submit")!, "failed", "NOT_READY");
    expect(claimNext(session, "stop")!.batch_id).toBe(a);
  });

  test("pause goes ahead of queued sends; batches read via the inbox or sent to an old run are not delivered", () => {
    const { session, run, target } = start("q4");
    const read = send(session, run, "read through the inbox");
    const plain = send(session, run, "ordinary");
    const pause = send(session, run, "", "pause");
    callTool("foreman_inbox", { target, request_id: crypto.randomUUID(), ack: [{ batch_id: read, state: "seen" }] }, { source: "mcp", envTerminal: null });
    expect(claimNext(session, "post_tool_use")!.batch_id).toBe(pause);

    const next = start("q4", "resume"); // new run: the old run's queued batch waits for a retarget
    expect(next.run).not.toBe(run);
    expect(claimNext(session, "post_tool_use")).toBeNull();
    expect(statusOf(session, plain)).toBe("queued");
  });

  test("concurrent consumers in separate processes never claim a batch twice", async () => {
    const { session, run } = start("race");
    const ids = Array.from({ length: 40 }, (_, i) => send(session, run, `b${i}`));
    const routes = ["post_tool_use", "stop", "idle_submit"];
    const kids = Array.from({ length: 6 }, (_, i) =>
      Bun.spawn(["bun", join(import.meta.dir, "fixtures/claim-child.ts"), session, routes[i % 3]!], { env: { ...process.env, FOREMAN_HOME: tmp.home() }, stdout: "inherit", stderr: "inherit" }),
    );
    await Promise.all(kids.map((k) => k.exited));
    const claims = sessionJournal(session).readAll().filter((e) => e.type === "delivery.claimed");
    const perBatch = new Map<string, number>();
    for (const c of claims) perBatch.set((c.payload as any).batch_id, (perBatch.get((c.payload as any).batch_id) ?? 0) + 1);
    expect([...perBatch.values()].every((n) => n === 1)).toBe(true);
    expect(ids.every((id) => perBatch.has(id))).toBe(true);
    expect(new Set(claims.map((c) => (c.payload as any).claimer_pid)).size).toBeGreaterThan(1);
  }, 30_000);

  test("Retry: uncertain always; unsettled only when orphaned; sent-but-unseen only after two minutes", () => {
    const { session, run } = start("r1");
    const a = send(session, run, "x");
    const c = claimNext(session, "post_tool_use")!;
    const batch = () => foldJournal(sessionJournal(session).readAll())!.work.batches[a]!;
    expect(retryable(batch(), { orphaned: false, now: Date.now() })).toBe(false); // live claimer: still in flight
    expect(retryable(batch(), { orphaned: true, now: Date.now() })).toBe(true);
    settle(c, "transport_sent");
    expect(() => retryBatch(session, a)).toThrow(/transport_sent/);
    const later = Date.now() + UNSEEN_RETRY_MS + 1000;
    retryBatch(session, a, { now: later });
    expect(statusOf(session, a)).toBe("queued"); // a new attempt on the same batch/action ids
    expect(claimNext(session, "stop")!.batch_id).toBe(a);
  });

  test("a UserPromptSubmit marker confirms only the attempt claimed before it", () => {
    const { session, run } = start("r2");
    const a = send(session, run, "x");
    const c1 = claimNext(session, "idle_submit")!;
    settle(c1, "uncertain", "no busy signal");
    onUserPrompt(session, batchMarkers(`${idleLead(a)}\nbody`));
    expect(statusOf(session, a)).toBe("transport_sent");
    retryBatch(session, a, { now: Date.now() + UNSEEN_RETRY_MS + 1 });
    claimNext(session, "idle_submit"); // the retry's attempt: the old sighting must not vouch for it
    expect(statusOf(session, a)).toBe("attempting");
    expect(batchMarkers("[foreman batch not-a-uuid] and [foreman batch " + a + "] twice [foreman batch " + a + "]")).toEqual([a]);
  });

  test("frozen text is always typeable (no control characters) and the idle lead is one safe line", () => {
    const { session, run } = start("r3");
    const id = crypto.randomUUID();
    const { batch } = createBatch(session, { batch_id: id, run, kind: "send", actions: [{ type: "note", action_id: crypto.randomUUID(), text: "a\r\nb\u001b[201~c\u0007" }] });
    expect(batch.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(batch.text).toContain("a\nb");
    const lead = idleLead(id);
    expect(lead.length).toBeLessThanOrEqual(300);
    expect(lead).toMatch(/^\[foreman batch [0-9a-f-]{36}\] [^\n]+$/);
  });
});
