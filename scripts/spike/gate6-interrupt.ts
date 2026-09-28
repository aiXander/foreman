// Gate 6 — the interrupt key for a managed turn (the pending Pause/Stop decision): which byte
// stops a running turn cleanly, keeps the conversation and the process, and what hooks fire.
// Usage: bun scripts/spike/gate6-interrupt.ts   (~4 tiny turns, one cut short)
import { rmSync } from "node:fs";
import { assistantTexts, gate, hooks, Hosted, leadFor, log, setCtl, startServices, until } from "./harness";

rmSync("/tmp/fh/spike/hooks.jsonl", { force: true });
setCtl({});
const svc = startServices();
const { check, done } = gate();

let h: Hosted | null = null;
try {
  h = await Hosted.launch(["--allowedTools", "Bash(sleep:*)"]);
  const target = await h.bound();
  const start = async (text: string) => {
    const s = await h!.ready();
    const batch = crypto.randomUUID();
    const r = await h!.submit(leadFor(batch), text, s.input_epoch, target);
    if (r.status !== "submitted") throw new Error(`no turn: ${JSON.stringify(r)}`);
    return batch;
  };
  const interrupt = async (label: string, key: string, text: string, when: (batch: string) => boolean | Promise<boolean>) => {
    const mark = hooks().length;
    const batch = await start(text);
    await until(`${label}: interrupt point`, () => when(batch), 60000, 50);
    const t0 = Date.now();
    await h!.type(key);
    const idle = await until("progress idle", async () => (await h!.info()).progress === "idle", 30000).catch(() => false);
    const ms = Date.now() - t0;
    const st = await h!.state();
    const info = await h!.info();
    const scr = await h!.screen();
    const restored = /draft/.test(st.reason ?? "");
    const fired = hooks().slice(mark).map((x) => x.event).filter((e) => e !== "PreToolUse" && e !== "UserPromptSubmit");
    check(`${label}: turn stops, process alive`, !!idle && info.state === "live", `${ms} ms, "${scr.split("\n").find((l) => /Interrupted/.test(l))?.trim() ?? "no Interrupted line"}", prompt restored as draft=${restored}, hooks after submit: ${fired.join(",") || "none"}`);
    if (restored) await h!.clearDraft(); // clear the restored text like a human would
    return restored;
  };
  // Streaming started = an assistant block (⏺) is on screen below this batch's echoed prompt.
  // (Or the echoed prompt already scrolled off screen: output is certainly streaming then.)
  const streaming = async (batch: string) => {
    if ((await h!.info()).progress !== "busy") return false;
    const rows = (await h!.screen()).split("\n");
    const at = rows.findIndex((l) => l.includes(batch.slice(0, 8)));
    return at < 0 || rows.slice(at).some((l) => l.startsWith("⏺") && l.length > 12);
  };

  // A. ESC while the model is streaming text.
  await interrupt("ESC mid-generation", "\x1b", "Write a 400-word story about a lighthouse keeper named Ilse.", streaming);
  // B. ESC while a Bash tool runs (sleep 30 is pre-allowed).
  await interrupt("ESC mid-tool", "\x1b", "Use the Bash tool to run exactly: sleep 30. Then reply with only: SLEPT", () => hooks().some((x) => x.event === "PreToolUse" && x.tool === "Bash"));
  // C. Ctrl-C while streaming.
  await interrupt("Ctrl-C mid-generation", "\x03", "Write a 400-word story about a baker named Ruben.", streaming);
  // E. ESC right after the turn starts, before any output: Claude puts the prompt back as a draft.
  const early = await interrupt("ESC before first token", "\x1b", "Write a 400-word story about a sailor named Mo.", async () => (await h!.info()).progress === "busy");
  // Observation, not a gate: whether ESC lands before the first token is timing-dependent. When it
  // does, Claude restores the prompt into the input box, which then blocks idle delivery as a draft.
  log(`observation: early interrupt restored the prompt as a draft: ${early}`);

  // The conversation survived all three interrupts.
  const s = await h.ready();
  await h.submit(leadFor(crypto.randomUUID()), "Name the two characters of the stories you started, comma-separated, nothing else.", s.input_epoch, target);
  const mem = await until("memory reply", () => assistantTexts(h!.native).find((t) => /Ilse/.test(t) && /Ruben/.test(t) && t.length < 60), 60000).catch(() => null);
  check("conversation kept across interrupts", !!mem, JSON.stringify(mem));

  // D. Safety of the key when idle: a single ESC on an idle, empty prompt changes nothing.
  await h.ready();
  await h.type("\x1b");
  await Bun.sleep(800); // observation window only
  const after = await h.state();
  const scr = await h.screen();
  check("single ESC on an idle prompt is harmless", after.ready && !/Rewind|restore the code/i.test(scr), `ready=${after.ready} reason=${after.reason}`);
} catch (e) {
  check("gate 6 run completed", false, (e as Error).message.slice(0, 600));
  if (h) console.log(await h.screen());
} finally {
  await h?.kill();
  await Bun.sleep(500);
  await svc.stop();
}
done();
