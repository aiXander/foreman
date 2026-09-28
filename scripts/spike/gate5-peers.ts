// Gate 5 — native peer addressing: two explicitly created, named test sessions find each other
// with Claude's built-in ListAgents and exchange a message with SendMessage.
// Usage: bun scripts/spike/gate5-peers.ts   (~2–3 tiny turns)
import { rmSync } from "node:fs";
import { assistantTexts, gate, hooks, Hosted, leadFor, log, setCtl, startServices, until, userTexts } from "./harness";

rmSync("/tmp/fh/spike/hooks.jsonl", { force: true });
setCtl({});
const svc = startServices();
const { check, done } = gate();
const suffix = crypto.randomUUID().slice(0, 4);
const A = `fm-spike-a-${suffix}`;
const B = `fm-spike-b-${suffix}`;
const allow = ["--allowedTools", "ListAgents SendMessage"];

let a: Hosted | null = null;
let b: Hosted | null = null;
try {
  a = await Hosted.launch(allow, A);
  b = await Hosted.launch(allow, B);
  const [ta] = [await a.bound(), await b.bound()];
  const s = await a.ready();
  await a.submit(
    leadFor(crypto.randomUUID()),
    `Use ListAgents to find the local session named exactly ${B}. Then use SendMessage to send it exactly this text: PEER-PING-${suffix}. Do not message any other session. Then reply with only: SENT`,
    s.input_epoch,
    ta,
  );
  const sent = await until("A replies SENT", () => assistantTexts(a!.native).find((t) => t.includes("SENT")), 90000).catch(() => null);
  const aTools = hooks().filter((x) => x.session_id === a!.native && x.event === "PreToolUse").map((x) => x.tool);
  check("A discovers and messages B with native tools", !!sent && aTools.includes("ListAgents") && aTools.includes("SendMessage"), `A tools=${aTools.join(",")}`);
  const got = await until("B receives the message", () => {
    const u = userTexts(b!.native).find((x) => x.includes(`PEER-PING-${suffix}`));
    return u ?? hooks().find((x) => x.session_id === b!.native && x.event === "UserPromptSubmit") ?? null;
  }, 60000).catch(() => null);
  const bScreen = await b.screen();
  check("B receives it (as a new turn / inbound message)", !!got, typeof got === "string" ? JSON.stringify(got.slice(0, 200)) : JSON.stringify(got)?.slice(0, 200));
  if (!got) console.log(bScreen);
  await b.ready(60000).catch(() => {});
  log("B transcript tail:", JSON.stringify(assistantTexts(b.native).slice(-2)).slice(0, 300));
} catch (e) {
  check("gate 5 run completed", false, (e as Error).message.slice(0, 600));
  if (a) console.log(await a.screen());
} finally {
  await a?.kill();
  await b?.kill();
  await Bun.sleep(500);
  await svc.stop();
}
done();
