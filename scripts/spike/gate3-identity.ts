// Gate 3 — identity across the lifecycle with a real Claude (haiku): plugin skill + MCP namespace,
// SessionStart additionalContext on startup / compact / clear / resume, and ptyd routing after
// in-TUI /clear and /resume and after a process-restart --resume.
// Usage: bun scripts/spike/gate3-identity.ts   (~6 tiny turns + one compaction)
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assistantTexts, gate, hooks, Hosted, leadFor, log, REPO, setCtl, startServices, until } from "./harness";

const { foldJournal } = await import("../../src/shared/reducer");
const { listSessionIds, sessionJournal, lookupNative } = await import("../../src/shared/store");

rmSync("/tmp/fh/spike/hooks.jsonl", { force: true });
rmSync("/tmp/fh/spike/mcp.jsonl", { force: true });
setCtl({ sessionStartContext: true });
const svc = startServices();
const { check, done } = gate();
const journal = (native: string) => {
  const s = lookupNative("claude", native);
  return s ? { session: s, state: foldJournal(sessionJournal(s).readAll())!, events: sessionJournal(s).readAll() } : null;
};
const transcript = (native: string) => {
  const f = join(process.env.HOME!, ".claude/projects", REPO.replace(/[^A-Za-z0-9]/g, "-"), `${native}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const mcp = () => (existsSync("/tmp/fh/spike/mcp.jsonl") ? readFileSync("/tmp/fh/spike/mcp.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const injected = (source: string, after = 0) => until(`SessionStart ${source}`, () => hooks().slice(after).find((x) => x.event === "SessionStart" && x.source === source && x.injected), 90000);

let h: Hosted | null = null;
let h2: Hosted | null = null;
try {
  h = await Hosted.launch(["--allowedTools", "mcp__plugin_foreman_foreman__ping"]);
  const n1 = h.native;
  const target1 = await h.bound();
  const ask = async (host: Hosted, target: string, native: string, text: string, expect: string) => {
    const s = await host.ready();
    await host.submit(leadFor(crypto.randomUUID()), text, s.input_epoch, target);
    return until(`reply with ${expect}`, () => assistantTexts(native).find((t) => t.includes(expect)), 90000).catch(() => null);
  };
  const askToken = (host: Hosted, target: string, native: string, token: string) =>
    ask(host, target, native, "What is the most recent Foreman context token in your context? Reply with only that token.", token);

  // 1. Startup: skill namespace, MCP namespace + sidecar identity, startup context.
  const start = await injected("startup");
  const reply = await ask(h, target1, n1, "Load the foreman:foreman skill with the Skill tool, then call the mcp__plugin_foreman_foreman__ping tool once. Then reply with the skill token and the most recent Foreman context token, nothing else.", "SKILL-TOKEN-7Q4");
  const skillHook = hooks().find((x) => x.event === "PreToolUse" && x.tool === "Skill");
  const pingHook = hooks().find((x) => x.event === "PreToolUse" && x.tool?.includes("ping"));
  const call = mcp().find((m) => m.call);
  check("plugin skill loads as foreman:foreman", skillHook?.skill === "foreman:foreman" && !!reply, `Skill(${skillHook?.skill}) reply=${JSON.stringify(reply)}`);
  check("SessionStart context arrives on startup", !!reply?.includes(start.injected) && transcript(n1).includes(start.injected), start.injected);
  check("plugin MCP tool is mcp__plugin_foreman_foreman__ping; sidecar inherits FOREMAN_TERMINAL_ID", pingHook?.tool === "mcp__plugin_foreman_foreman__ping" && call?.terminal === h.id, `tool=${pingHook?.tool} sidecar terminal=${call?.terminal} pid=${call?.pid}`);

  // 2. /compact keeps the run and the route; context is re-injected with source=compact.
  let mark = hooks().length;
  await h.ready();
  await h.type("/compact\r");
  const comp = await injected("compact", mark);
  const j1c = journal(n1)!;
  const infoC = await h.info();
  check("compaction keeps run + target; ptyd route unchanged", j1c.state.target === target1 && infoC.target === target1 && j1c.events.some((e: any) => e.type === "run.compacted"), `target=${infoC.target}`);
  const rc = await askToken(h, target1, n1, comp.injected);
  check("SessionStart context arrives after compaction", !!rc && transcript(n1).includes(comp.injected), `${comp.injected} reply=${JSON.stringify(rc)}`);

  // 3. /clear: new conversation on the same terminal → new session, rebinding, old run ended.
  mark = hooks().length;
  await h.ready();
  await h.type("/clear\r");
  const clr = await injected("clear", mark);
  const n2 = clr.session_id;
  const target2 = await until("rebind after /clear", async () => {
    const t = (await h!.info()).target;
    return t !== target1 ? t : null;
  });
  const j2 = journal(n2)!;
  // Claude's SessionEnd(reason=clear) retires the old run before SessionStart would mark it "rebound".
  const oldEnd = journal(n1)!.events.find((e: any) => e.type === "run.ended" && e.run === j1c.state.run) as any;
  check("/clear routes the terminal to the new session", n2 !== n1 && j2.state.target === target2 && j2.state.terminal_id === h.id && ["clear", "rebound"].includes(oldEnd?.payload.reason), `new native=${n2.slice(0, 8)} target=${target2.slice(0, 8)} old run ended: ${oldEnd?.payload.reason}`);
  const rcl = await askToken(h, target2, n2, clr.injected);
  check("SessionStart context arrives after /clear", !!rcl && transcript(n2).includes(clr.injected), `${clr.injected} reply=${JSON.stringify(rcl)}`);
  const e1 = await h.submit(leadFor(crypto.randomUUID()), "Reply with only: NOPE", (await h.state()).input_epoch, target1).then(() => "submitted", (e: any) => e.code);
  check("the pre-/clear target can no longer submit", e1 === "CONFLICT", e1);
  const sidecars = new Set(mcp().filter((m) => m.started).map((m) => m.pid));
  check("MCP sidecar survives /clear (it cannot know the current session itself)", sidecars.size === 1, `sidecar pids=${[...sidecars]}`);

  // 4. In-TUI /resume <first session>: routes back to the first session with a new run.
  mark = hooks().length;
  await h.ready();
  await h.type(`/resume ${n1}\r`);
  const res = await injected("resume", mark).catch(async (e) => {
    log(await h!.screen());
    throw e;
  });
  const target3 = await until("rebind after /resume", async () => {
    const t = (await h!.info()).target;
    return t !== target2 ? t : null;
  });
  const j1r = journal(n1)!;
  check("/resume routes the terminal back to the first session (new run)", res.session_id === n1 && j1r.state.target === target3 && j1r.state.run !== j1c.state.run && journal(n2)!.state.state === "dead", `target=${target3.slice(0, 8)} session2 state=${journal(n2)!.state.state}`);
  const rr = await askToken(h, target3, n1, res.injected);
  check("SessionStart context arrives on /resume", !!rr && transcript(n1).includes(res.injected), `${res.injected} reply=${JSON.stringify(rr)}`);

  // 5. Process restart: a new ptyd terminal with --resume <first session>.
  await h.kill();
  await until("first session ended", () => journal(n1)!.state.state === "dead", 15000);
  mark = hooks().length;
  h2 = await Hosted.launch(["--resume", n1]);
  const res2 = await injected("resume", mark);
  const target4 = await h2.bound();
  const j1p = journal(n1)!;
  check("process-restart --resume: same Foreman session, new run, new terminal bound", res2.session_id === n1 && j1p.session === j1r.session && j1p.state.terminal_id === h2.id && j1p.state.target === target4 && target4 !== target3, `session=${j1p.session.slice(0, 8)} terminal=${h2.id.slice(0, 8)}`);
  const rp = await askToken(h2, target4, n1, res2.injected);
  check("SessionStart context arrives on process-restart resume", !!rp, `${res2.injected} reply=${JSON.stringify(rp)}`);
} catch (e) {
  check("gate 3 run completed", false, (e as Error).message.slice(0, 800));
  if (h) console.log(await h.screen().catch(() => ""));
} finally {
  await h?.kill();
  await h2?.kill();
  await Bun.sleep(500);
  await svc.stop();
}
done();
