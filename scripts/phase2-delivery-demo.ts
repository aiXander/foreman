// Phase-2 delivery exit evidence with a REAL Claude (haiku) in the isolated FOREMAN_HOME=/tmp/fh:
// the product plugin's hook routes and the daemon's idle worker deliver human batches.
//  A. mid-turn: PostToolUse hands a queued batch to the running turn
//  B. a failed tool: PostToolUseFailure delivers the same way
//  C. turn end: Stop continues the turn once (the 2nd Stop has stop_hook_active and claims nothing)
//  D. nothing queued: exactly one Stop, no continuation (no loop)
//  E. idle: the daemon worker types the batch as a new turn; UserPromptSubmit corroborates it
//  F. pause mid-turn parks the turn; a send queued before it stays parked, never typed
// While a batch must wait for a *hook* (A–C, F) the script holds the terminal's writer lease,
// exactly like a human with the terminal open: the idle worker then never types (it says why).
// ~7 tiny haiku turns. Ask Xander before running. Usage: bun scripts/phase2-delivery-demo.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal as XTerm } from "@xterm/headless";

const HOME = "/tmp/fh";
process.env.FOREMAN_HOME = HOME;
process.env.FOREMAN_PORT = "7801";
const repo = join(import.meta.dir, "..");
const cli = join(repo, "src/cli/main.ts");
// The repo itself: a folder Claude already trusts (a new folder opens the trust dialog, and
// accepting it would write Claude's own config). The turns only read files that exist here.
const cwd = repo;

const { PtyClient } = await import("../src/shared/ptyclient");
const { b64 } = await import("../src/shared/ptyproto");
const { managedClaudeArgv } = await import("../src/shared/config");
const { paths } = await import("../src/shared/paths");
const { createBatch } = await import("../src/shared/delivery");
const { foldJournal } = await import("../src/shared/reducer");
const { sessionJournal, readJson } = await import("../src/shared/store");
const { batchStatus } = await import("../src/shared/work");

const results: boolean[] = [];
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => {
  results.push(ok);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function until<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_|CMUX_|C11_)/.test(k)) env[k] = v;
const svc = (cmd: string) => Bun.spawn(["bun", cli, cmd], { env, stdout: "ignore", stderr: "inherit" });

const ptyd = svc("ptyd");
const daemon = svc("daemon");
let ctl: Awaited<ReturnType<typeof PtyClient.connect>> | null = null;
let tid = "";
// The viewer's mirror of the screen, printed when something times out.
const xt = new XTerm({ cols: 110, rows: 32, allowProposedApi: true });
const screen = () => new Promise<string>((res) => xt.write("", () => {
  const b = xt.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < xt.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
  res(rows.filter((r) => r.trim()).join("\n"));
}));

try {
  ctl = await until("ptyd", () => PtyClient.connect({ client: "cli" }));
  const viewer = crypto.randomUUID();
  const { terminal } = await ctl.request<any>({ op: "create", request_id: crypto.randomUUID(), cwd, argv: managedClaudeArgv(["--model", "haiku"]), cols: 110, rows: 32, env });
  tid = terminal.terminal_id;
  ctl.onPush((p: any) => {
    if (p.terminal_id !== tid) return;
    if (p.event === "snapshot_begin") (xt.reset(), xt.resize(p.cols, p.rows));
    else if (p.event === "snapshot_chunk" || p.event === "output") xt.write(b64.decode(p.data_b64));
    else if (p.event === "resize") xt.resize(p.cols, p.rows);
  });
  await ctl.request({ op: "attach", terminal_id: tid, viewer_id: viewer });
  const route = await until("SessionStart registration", () => readJson<{ session: string; run: string }>(paths.byTerminalEntry(tid)), 60000);
  const session = route.session;
  const state = () => foldJournal(sessionJournal(session).readAll())!;
  const term = async () => (await ctl!.request<any>({ op: "list" })).terminals.find((t: any) => t.terminal_id === tid);
  await until("daemon bind + idle prompt", async () => {
    const t = await term();
    return t?.target === state().target && t.progress === "idle";
  });
  log(`session ${session} (native ${state().native_id})`);

  const lease = (action: "acquire" | "release") => ctl!.request({ op: "control", terminal_id: tid, viewer_id: viewer, action });
  const typePrompt = async (text: string) => {
    await ctl!.request({ op: "write", terminal_id: tid, viewer_id: viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode(text)) });
    await Bun.sleep(300);
    await ctl!.request({ op: "write", terminal_id: tid, viewer_id: viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode("\r")) });
  };
  const send = (kind: "send" | "pause", text = "") => {
    const batch_id = crypto.randomUUID();
    const action = kind === "pause" ? { type: "pause" as const, action_id: crypto.randomUUID() } : { type: "note" as const, action_id: crypto.randomUUID(), text };
    createBatch(session, { batch_id, run: state().run!, kind, actions: [action] });
    return batch_id;
  };
  const runStarted = () => sessionJournal(session).readAll().findLast((e) => e.type === "run.started")?.payload as { transcript_path: string | null } | undefined;
  const transcript = () => assistantTexts(runStarted());
  const replied = (token: string) => until(`a reply containing ${token}`, () => transcript().some((t) => t.includes(token)), 90000).then(() => true, () => false);
  const idle = () => until("turn end (OSC 9;4 idle)", async () => (await term())?.progress === "idle", 90000);
  const busy = () => until("turn start", async () => (await term())?.progress === "busy", 20000);
  const routes = (b: string) => state().work.batches[b]!.attempts.map((a) => `${a.route}:${a.outcome}`);
  const stops = () => sessionJournal(session).readAll().filter((e) => e.type === "activity" && (e.payload as any).hook === "Stop").length;
  const hookBefore = (b: string) => {
    const ev = sessionJournal(session).readAll();
    const i = ev.findIndex((e) => e.type === "delivery.claimed" && (e.payload as any).batch_id === b);
    return (ev.slice(0, i).findLast((e) => e.type === "activity")?.payload as any)?.hook ?? null;
  };

  // A. mid-turn
  await lease("acquire");
  const a = send("send", "Also include the word QUEUED-A in your final reply.");
  await typePrompt("Use the Read tool to read LICENSE, then reply with only: READ-A");
  const okA = await replied("QUEUED-A");
  await idle();
  check("A. PostToolUse hands a queued batch to the running turn", okA && routes(a).join() === "post_tool_use:transport_sent", `routes=${routes(a)}`);

  // B. failed tool
  const b = send("send", "Also include the word QUEUED-B in your final reply.");
  await typePrompt("Use the Read tool to read foreman-missing-file.txt (it does not exist), then reply with only: TRIED-B");
  const okB = await replied("QUEUED-B");
  await idle();
  check("B. PostToolUseFailure delivers the same way", okB && routes(b).join() === "post_tool_use:transport_sent" && hookBefore(b) === "PostToolUseFailure", `routes=${routes(b)} after=${hookBefore(b)}`);

  // C. turn end
  const s0 = stops();
  const c = send("send", "Reply with only: QUEUED-C");
  await typePrompt("Reply with only: PLAIN-C");
  const okC = await replied("QUEUED-C");
  await idle();
  await Bun.sleep(1500);
  check("C. Stop continues the turn once with the batch", okC && routes(c).join() === "stop:transport_sent" && stops() - s0 === 2, `routes=${routes(c)} stops=${stops() - s0}`);

  // D. nothing queued
  const s1 = stops();
  await typePrompt("Reply with only: PLAIN-D");
  await replied("PLAIN-D");
  await idle();
  await Bun.sleep(2000);
  check("D. empty queue: one Stop, no loop", stops() - s1 === 1, `stops=${stops() - s1}`);

  // E. idle submit by the daemon worker
  await lease("release");
  const e = send("send", "Reply with only: QUEUED-E");
  const okE = await replied("QUEUED-E");
  await idle();
  const be = state().work.batches[e]!;
  check("E. idle batch typed by the daemon worker as a new turn, corroborated by UserPromptSubmit", okE && routes(e).join() === "idle_submit:transport_sent" && !!be.corroborated_at, `routes=${routes(e)} corroborated=${!!be.corroborated_at}`);
  log(`   receipts: ${["A", a, "B", b, "C", c, "E", e].join(" ").replace(/([0-9a-f-]{36})/g, (id) => batchStatus(state().work.batches[id]!))} (seen/acted = the model acked via foreman_inbox)`);

  // F. pause mid-turn
  // Pressed while the turn runs (on an idle session a pause is moot and cancelled at once).
  await lease("acquire");
  await typePrompt("Read LICENSE, then package.json, then tsconfig.json with the Read tool, one call at a time, then reply with only: DONE-F");
  await busy();
  const parked = send("send", "Reply with only: PARKED-F");
  const p = send("pause");
  await idle();
  await lease("release");
  await Bun.sleep(4000); // the idle worker must NOT type the parked send
  const reads = sessionJournal(session).readAll().filter((x) => x.type === "activity" && (x.payload as any).hook === "PostToolUse" && (x.payload as any).tool === "Read").length;
  const readsF = reads - 1; // A read LICENSE once
  check("F. pause parks the turn; the send queued before it stays parked", routes(p).join() === "post_tool_use:transport_sent" && batchStatus(state().work.batches[parked]!) === "queued", `pause=${routes(p)} parked=${batchStatus(state().work.batches[parked]!)} reads-in-F=${readsF}/3 DONE-F=${transcript().some((t) => t.includes("DONE-F"))}`);
} catch (err) {
  check("demo ran to completion", false, (err as Error).message);
  console.log(await screen());
} finally {
  if (ctl && tid) await ctl.request({ op: "kill", terminal_id: tid }).catch(() => {});
  ctl?.close();
  await Bun.sleep(1000);
  daemon.kill("SIGTERM");
  ptyd.kill("SIGTERM");
  await Promise.all([daemon.exited, ptyd.exited]);
}
const failed = results.filter((r) => !r).length;
log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

function assistantTexts(run: { transcript_path: string | null } | undefined): string[] {
  const f = run?.transcript_path;
  if (!f || !existsSync(f)) return [];
  const out: string[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r.type === "assistant") for (const c of r.message?.content ?? []) if (c.type === "text") out.push(c.text);
    } catch {}
  }
  return out;
}
