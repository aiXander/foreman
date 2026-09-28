// Gate 4 — an observed session: Claude started OUTSIDE ptyd (its own PTY in this process, like a
// user's terminal) with --plugin-dir. It must register as observed, never be bound to a ptyd
// terminal, and still receive mid-turn delivery through PostToolUse / Stop.
// Usage: bun scripts/spike/gate4-observed.ts   (~2 tiny turns)
import { readFileSync, rmSync } from "node:fs";
import { assistantTexts, CLAUDE, gate, hooks, log, setCtl, SPIKE_PLUGIN, startServices, until } from "./harness";
import { enqueue, history } from "./queue";
import { Tui } from "./tui";
import { readiness } from "../../src/ptyd/readiness";
import { foldJournal } from "../../src/shared/reducer";
import { lookupNative, sessionJournal } from "../../src/shared/store";

rmSync("/tmp/fh/spike/hooks.jsonl", { force: true });
setCtl({ postToolUse: true, stop: "context" });
const svc = startServices();
const { check, done } = gate();
const api = async (path: string) => {
  const token = readFileSync("/tmp/fh/secrets/ui-token", "utf8").trim();
  return (await (await fetch(`http://127.0.0.1:7801${path}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
};

let t: Tui | null = null;
try {
  await until("daemon", () => api("/api/v1/sessions"));
  t = new Tui([CLAUDE, "--plugin-dir", SPIKE_PLUGIN, "--model", "haiku"], "observed");
  const native = await until("observed SessionStart", () => hooks().find((x) => x.event === "SessionStart" && x.terminal === null)?.session_id, 45000);
  const view = await until("daemon lists the observed session", async () => (await api("/api/v1/sessions")).sessions.find((s: any) => s.native_id === native && s.process === "alive"), 20000);
  check("observed session registers and is visible", view.mode === "observed" && view.terminal_id === null, `mode=${view.mode} process=${view.process} state=${view.state} terminal=${view.terminal_id}`);
  const { terminals } = await api("/api/v1/sessions");
  const jt = foldJournal(sessionJournal(lookupNative("claude", native)!).readAll())!.target;
  check("no ptyd terminal is bound to it", !!jt && !(terminals ?? []).some((x: any) => x.target === jt), `journal target=${jt?.slice(0, 8)}, ${(terminals ?? []).length} ptyd terminals`);

  // A human types in the external terminal; a batch queued meanwhile arrives via PostToolUse.
  const flushed = () => new Promise<void>((r) => t!.xt.write("", r));
  await until("external prompt ready", async () => (await flushed(), readiness(t!.xt, t!.progress).ready), 30000);
  t.write("\x1b[200~Use the Read tool to read package.json, then reply with only: READ-O\x1b[201~\r");
  await until("turn started", () => t!.progress === "busy", 10000);
  const q = enqueue(native, "Also include the word QUEUED-O in your final reply.");
  const reply = await until("reply with QUEUED-O", () => assistantTexts(native).find((x) => x.includes("QUEUED-O")), 60000).catch(() => null);
  const routes = history(native).filter((r: any) => r.type === "claimed" && r.batch_id === q).map((r: any) => r.route);
  check("observed session receives a batch mid-turn", !!reply && routes.length === 1, `routes=${routes} reply=${JSON.stringify(reply)}`);

  // An idle observed session: the batch stays queued (no terminal to type into) until a hook fires.
  await until("idle again", async () => (await flushed(), readiness(t!.xt, t!.progress).ready), 30000);
  const q2 = enqueue(native, "Reply with only: QUEUED-O2");
  await Bun.sleep(3000); // observation window: nothing may claim it while idle
  const idleClaims = history(native).filter((r: any) => r.type === "claimed" && r.batch_id === q2).length;
  check("idle observed batch stays queued", idleClaims === 0, `claims after 3 s idle: ${idleClaims}`);
  t.write("\x1b[200~Reply with only: HUMAN-O\x1b[201~\r");
  const r2 = await until("QUEUED-O2 after the human's own turn", () => assistantTexts(native).find((x) => x.includes("QUEUED-O2")), 60000).catch(() => null);
  const r2routes = history(native).filter((r: any) => r.type === "claimed" && r.batch_id === q2).map((r: any) => r.route);
  check("…and is delivered when the human starts a turn (Stop hook)", !!r2 && r2routes.join() === "Stop", `routes=${r2routes}`);
} catch (e) {
  check("gate 4 run completed", false, (e as Error).message.slice(0, 600));
  if (t) console.log(await t.screen());
} finally {
  t?.kill();
  await Bun.sleep(800);
  await svc.stop();
}
done();
