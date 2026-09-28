// Gate 1 — idle delivery through ptyd `input_state` + `submit` against a real Claude (haiku).
// Usage: bun scripts/spike/gate1-idle.ts   (FOREMAN_HOME=/tmp/fh, port 7801; ~6 tiny turns)
import { rmSync } from "node:fs";
import { assistantTexts, gate, hooks, Hosted, leadFor, log, setCtl, startServices, until, userTexts } from "./harness";

rmSync("/tmp/fh/spike/hooks.jsonl", { force: true });
setCtl({});
const svc = startServices();
const { check, done } = gate();
const err = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e: any) {
    return `${e.code}: ${e.message}`;
  }
};

let h: Hosted | null = null;
try {
  h = await Hosted.launch();
  const target = await h.bound();
  log("bound", h.id, "->", target, "native", h.native);

  /** One idle batch: wait ready, submit, then wait for the reply text in the transcript. */
  const deliver = async (label: string, body: string, expect: string) => {
    const st = await h!.ready();
    const batch = crypto.randomUUID();
    const t0 = Date.now();
    const r = await h!.submit(leadFor(batch), body, st.input_epoch, target);
    const ups = await until("UserPromptSubmit with marker", () => hooks().filter((x) => x.event === "UserPromptSubmit" && x.markers?.includes(batch)).length > 0 && hooks().filter((x) => x.event === "UserPromptSubmit" && x.markers?.includes(batch)), 15000).catch(() => []);
    const reply = await until(`reply ${expect}`, () => assistantTexts(h!.native).find((t) => t.includes(expect)), 60000).catch(() => null);
    const user = userTexts(h!.native).find((u) => u.includes(batch)) ?? "";
    check(
      `${label}: one clean turn`,
      r.status === "submitted" && ups.length === 1 && !!reply,
      `status=${r.status} echo=${r.echo_ms}ms start=${r.start_ms}ms UserPromptSubmit×${ups.length} reply=${JSON.stringify(reply?.slice(0, 60))} wrapped=${user.includes("<pasted_content")} total=${Date.now() - t0}ms`,
    );
    return { r, user };
  };

  // 1. Readiness and one plain batch.
  const s0 = await h.ready();
  check("ready at startup (idle report + empty prompt)", s0.ready && s0.progress === "idle", JSON.stringify(s0));
  await deliver("single line", "Reply with only: IDLE-ONE", "IDLE-ONE");
  const stops = hooks().filter((x) => x.event === "Stop");
  check("no Stop loop on an empty queue", stops.length === 1, `Stop×${stops.length}`);

  // 2. Multiline + Unicode below the collapse threshold, and 3. a 16 KiB body.
  const uni = "Three lines follow.\nZweite Zeile: héllo — 日本語 🚀 ünïcödé\nReply with only: UNI-TWO ✓";
  const { user: u2 } = await deliver("multiline + Unicode", uni, "UNI-TWO");
  check("multiline + Unicode arrive byte-exact", u2.includes(uni), `user message ${u2.length} chars`);
  let big = "";
  for (let i = 0; Buffer.byteLength(big) < 16 * 1024 - 200; i++) big += `Filler line ${String(i).padStart(3, "0")}: padding that only tests paste size.\n`;
  big += "Reply with only: BIG-THREE";
  const { user: u3 } = await deliver(`16 KiB body (${Buffer.byteLength(big)} B)`, big, "BIG-THREE");
  check("16 KiB body arrives whole (collapsed paste)", u3.includes(big), `wrapped=${u3.includes("<pasted_content")}`);

  // 4. A half-typed human draft blocks delivery; nothing is written over it.
  await h.ready();
  await h.type("half typed draft");
  const sd = await until("draft seen", async () => {
    const s = await h!.state();
    return s.reason?.includes("draft") ? s : null;
  }, 5000);
  const e4 = await err(h.submit(leadFor(crypto.randomUUID()), "Reply with only: NOPE", sd.input_epoch, target));
  const scr4 = await h.screen();
  check("draft blocks submit (NOT_READY, draft untouched)", e4?.startsWith("NOT_READY") === true && scr4.includes("half typed draft") && !scr4.includes("NOPE"), e4 ?? "submitted!");
  await h.type("\x15"); // Ctrl-U clears the draft
  await h.ready(5000);
  check("clearing the draft makes it ready again", true);

  // 5. Manual typing between the readiness read and the submit invalidates it (input_epoch CAS).
  const s5 = await h.ready();
  await h.type("x");
  const e5 = await err(h.submit(leadFor(crypto.randomUUID()), "Reply with only: NOPE", s5.input_epoch, target));
  check("stale input_epoch is rejected before any write", e5?.startsWith("CONFLICT") === true, e5 ?? "submitted!");
  await h.type("\x7f");

  // 6. A human holding the writer lease blocks delivery until release.
  const s6 = await h.ready();
  await h.human.request({ op: "control", terminal_id: h.id, viewer_id: h.viewer, action: "acquire" });
  const e6 = await err(h.submit(leadFor(crypto.randomUUID()), "Reply with only: NOPE", s6.input_epoch, target));
  await h.human.request({ op: "control", terminal_id: h.id, viewer_id: h.viewer, action: "release" });
  check("held writer lease blocks submit", e6?.startsWith("CONFLICT") === true, e6 ?? "submitted!");

  // 7. Stale binding: a submit for another target is refused.
  const s7 = await h.ready();
  const e7 = await err(h.submit(leadFor(crypto.randomUUID()), "Reply with only: NOPE", s7.input_epoch, crypto.randomUUID()));
  check("stale target is rejected", e7?.startsWith("CONFLICT") === true, e7 ?? "submitted!");

  // 8. Open permission dialog: not ready while it is open; ready again after Esc (deny).
  const s8 = await h.ready();
  const r8 = await h.submit(leadFor(crypto.randomUUID()), "Use the Bash tool to run exactly: touch /tmp/fh/spike/perm-probe", s8.input_epoch, target);
  await until("permission dialog", async () => (await h!.screen()).includes("Do you want to proceed?"), 60000);
  const sd8 = await h.state();
  const e8 = await err(h.submit(leadFor(crypto.randomUUID()), "Reply with only: NOPE", sd8.input_epoch, target));
  check("permission dialog: not ready, submit refused", !sd8.ready && e8?.startsWith("NOT_READY") === true, `submit=${r8.status} state=${sd8.progress}/${sd8.reason} err=${e8}`);
  const perm = hooks().filter((x) => x.event === "PermissionRequest");
  check("PermissionRequest hook fired for the dialog", perm.length >= 1, `tool=${perm.at(-1)?.tool}`);
  await h.type("\x1b"); // Esc on the dialog: deny + interrupt the turn
  const s8b = await h.ready(15000);
  check("Esc on the dialog returns to a ready prompt", s8b.ready, (await h.screen()).split("\n").filter((l) => /Interrupted/.test(l)).join(" | "));
} catch (e) {
  check("gate 1 run completed", false, (e as Error).message.slice(0, 600));
  if (h) console.log(await h.screen());
} finally {
  await h?.kill();
  await Bun.sleep(500);
  await svc.stop();
}
done();
