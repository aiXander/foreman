// Gate 2 — mid-turn delivery (PostToolUse / Stop hook context) racing the idle-submit worker,
// against a real Claude (haiku). Every consumer claims from the same locked queue.
// Usage: bun scripts/spike/gate2-midturn.ts [context|block]   (~8 tiny turns)
import { rmSync } from "node:fs";
import { claimNext, enqueue, history, settle } from "./queue";
import { assistantTexts, gate, hooks, Hosted, leadFor, log, setCtl, startServices, until } from "./harness";

const stopMode = (process.argv[2] ?? "context") as "context" | "block";
rmSync("/tmp/fh/spike/hooks.jsonl", { force: true });
rmSync("/tmp/fh/spike/queue", { recursive: true, force: true });
setCtl({});
const svc = startServices();
const { check, done } = gate();

let h: Hosted | null = null;
let workerOn = true;
try {
  h = await Hosted.launch();
  const target = await h.bound();
  const native = h.native;
  const routes = (batch: string) => history(native).filter((r: any) => r.type === "claimed" && r.batch_id === batch).map((r: any) => r.route);
  const sawAck = (token: string) => until(`reply containing ${token}`, () => assistantTexts(native).some((t) => t.includes(token)), 60000).then(() => true, () => false);

  // The daemon-side idle worker: claims only when ptyd says the prompt is ready, claims BEFORE
  // writing, settles definitively on a refused submit, and leaves an uncertain one holding the queue.
  const worker = (async () => {
    while (workerOn) {
      try {
        const s = await h!.state();
        if (s.ready) {
          const c = claimNext(native, "idle_submit");
          if (c) {
            try {
              const r = await h!.submit(leadFor(c.batch_id), c.text, s.input_epoch, target, c.attempt);
              if (r.status === "submitted") settle(native, c, true);
              else log("worker: uncertain submit holds the queue", JSON.stringify(r));
            } catch (e: any) {
              settle(native, c, `refused: ${e.code}`);
            }
          }
        }
      } catch {}
      await Bun.sleep(100);
    }
  })();

  /** Start a turn directly (a human-typed prompt), bypassing the queue. */
  const humanTurn = async (text: string) => {
    const s = await h!.ready();
    const r = await h!.submit(leadFor(crypto.randomUUID()), text, s.input_epoch, target);
    if (r.status !== "submitted") throw new Error(`turn did not start: ${JSON.stringify(r)}`);
  };

  // A. Working turn with a tool call: the next PostToolUse carries the batch into the same turn.
  setCtl({ postToolUse: true, stop: "off" });
  await humanTurn("Use the Read tool to read package.json, then reply with only: READ-A");
  const qa = enqueue(native, "Also include the word QUEUED-A in your final reply.");
  const okA = await sawAck("QUEUED-A");
  await h.ready();
  check("PostToolUse additionalContext reaches the model mid-turn", okA && routes(qa).join() === "PostToolUse", `routes=${routes(qa)} reply=${JSON.stringify(assistantTexts(native).at(-1)?.slice(0, 80))}`);

  // B. Turn without tools: the Stop hook continues the turn once with the batch.
  setCtl({ postToolUse: true, stop: stopMode });
  const stopsBefore = hooks().filter((x) => x.event === "Stop").length;
  await humanTurn("Reply with only: PLAIN-B");
  const qb = enqueue(native, "Reply with only: QUEUED-B");
  const okB = await sawAck("QUEUED-B");
  await h.ready();
  const stopsB = hooks().filter((x) => x.event === "Stop").slice(stopsBefore);
  check(
    `Stop (${stopMode}) continues the turn once with a queued batch`,
    okB && routes(qb).join() === "Stop" && stopsB.length === 2 && stopsB[1].stop_hook_active === true,
    `routes=${routes(qb)} stops=${stopsB.map((s) => `active=${s.stop_hook_active} claimed=${s.claimed ?? "-"}`).join(" / ")}`,
  );

  // C. Nothing queued: exactly one Stop, no continuation.
  const c0 = hooks().filter((x) => x.event === "Stop").length;
  await humanTurn("Reply with only: PLAIN-C");
  await sawAck("PLAIN-C");
  await h.ready();
  const stopsC = hooks().filter((x) => x.event === "Stop").slice(c0);
  check("empty queue: one Stop, no loop", stopsC.length === 1 && !stopsC[0].claimed, `stops=${stopsC.length}`);

  // D. Idle: the worker delivers a batch queued while nothing is running.
  const qd = enqueue(native, "Reply with only: QUEUED-D");
  const okD = await sawAck("QUEUED-D");
  check("idle batch is submitted by the worker as a new turn", okD && routes(qd).join() === "idle_submit", `routes=${routes(qd)}`);

  // E. Busy→idle race, three times: batch queued as a short turn ends; Stop hook and worker both
  // try. Exactly one claims each batch, and the model sees each exactly once.
  const delays = [100, 700, 1300, 2000];
  for (let i = 1; i <= delays.length; i++) {
    await h.ready();
    await humanTurn(`Reply with only: RACE-${i}`);
    await Bun.sleep(delays[i - 1]!); // vary where around the turn's end the enqueue lands (spike jitter, not readiness)
    const q = enqueue(native, `Reply with only: RACED-${i}`);
    const ok = await sawAck(`RACED-${i}`);
    await h.ready();
    const seen = assistantTexts(native).filter((t) => t.includes(`RACED-${i}`)).length;
    check(`race ${i}: one claim, one delivery`, ok && routes(q).length === 1 && seen === 1, `routes=${routes(q)} replies=${seen}`);
  }
} catch (e) {
  check("gate 2 run completed", false, (e as Error).message.slice(0, 600));
  if (h) console.log(await h.screen());
} finally {
  workerOn = false;
  await h?.kill();
  await Bun.sleep(500);
  await svc.stop();
}
done();
