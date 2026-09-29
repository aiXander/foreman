// Phase-2 exit evidence (plan §18) with REAL Claude (haiku) in the isolated FOREMAN_HOME=/tmp/fh.
// The human side goes through the daemon's own HTTP routes (tray PUT → Send, Retry, Stop), exactly
// what the card does; only the "crash" in part 2 is simulated by claiming in-process.
//  1. Real task: the agent briefs, posts a decision + offer, asks a proceed and a blocking
//     question and ends its turn; the human answers the blocking one, overrides the assumed
//     answer, revisits the decision and accepts the offer in ONE Send; the agent acks every
//     action, the items close/revise, and it writes the handover.
//  2. An uncertain delivery holds the queue through a whole turn, until an explicit Retry.
//  3. With foremand DOWN, MCP calls persist and PostToolUse still delivers a batch.
//  4. Stop = one ESC into a busy real Claude: the turn ends, process + conversation stay.
//  5. Peers: a second, named session sees the first via foreman_peers (and its contract), then
//     messages it with native ListAgents + SendMessage; the first receives it.
//  6. Across every batch: no duplicate delivery claims.
// ~10 small haiku turns. Ask Xander before running. Usage: bun scripts/phase2-exit-demo.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal as XTerm } from "@xterm/headless";

const HOME = "/tmp/fh";
const PORT = 7801;
process.env.FOREMAN_HOME = HOME;
process.env.FOREMAN_PORT = String(PORT);
const repo = join(import.meta.dir, "..");
const cli = join(repo, "src/cli/main.ts");
// A folder Claude already trusts (a new one opens the trust dialog). The task edits no files.
const cwd = repo;

const { PtyClient } = await import("../src/shared/ptyclient");
const { b64 } = await import("../src/shared/ptyproto");
const { managedClaudeArgv } = await import("../src/shared/config");
const { paths } = await import("../src/shared/paths");
const { claimNext, createBatch, settle } = await import("../src/shared/delivery");
const { readPeers } = await import("../src/shared/peers");
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
    await Bun.sleep(200);
  }
}

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_|CMUX_|C11_)/.test(k)) env[k] = v;
const svc = (cmd: string) => Bun.spawn(["bun", cli, cmd], { env, stdout: "ignore", stderr: "inherit" });

// ---------- daemon API (bearer = the CLI's credential) ----------
let token = "";
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j as T;
}

// ---------- a hosted Claude ----------
interface Hosted {
  tid: string;
  name: string;
  viewer: string;
  xt: XTerm;
  session: string;
}
let ctl: Awaited<ReturnType<typeof PtyClient.connect>> | null = null;
const hosted: Hosted[] = [];

async function launch(name: string): Promise<Hosted> {
  const argv = managedClaudeArgv(["--model", "haiku", "--name", name]).map((a) => (a.startsWith("--allowedTools=") ? `${a},ListAgents,SendMessage` : a));
  const { terminal } = await ctl!.request<any>({ op: "create", request_id: crypto.randomUUID(), cwd, argv, cols: 110, rows: 32, env });
  const h: Hosted = { tid: terminal.terminal_id, name, viewer: crypto.randomUUID(), xt: new XTerm({ cols: 110, rows: 32, allowProposedApi: true }), session: "" };
  hosted.push(h);
  await ctl!.request({ op: "attach", terminal_id: h.tid, viewer_id: h.viewer });
  const route = await until(`${name} SessionStart`, () => readJson<{ session: string }>(paths.byTerminalEntry(h.tid)), 90000);
  h.session = route.session;
  await until(`${name} bound + idle`, async () => {
    const t = await term(h);
    return t?.target === state(h).target && t.progress === "idle";
  }, 90000);
  log(`${name}: session ${h.session}`);
  return h;
}

const state = (h: Hosted) => foldJournal(sessionJournal(h.session).readAll())!;
const term = async (h: Hosted) => (await ctl!.request<any>({ op: "list" })).terminals.find((t: any) => t.terminal_id === h.tid);
const lease = (h: Hosted, action: "acquire" | "release") => ctl!.request({ op: "control", terminal_id: h.tid, viewer_id: h.viewer, action });
async function typePrompt(h: Hosted, text: string) {
  const write = (s: string) => ctl!.request({ op: "write", terminal_id: h.tid, viewer_id: h.viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode(s)) });
  await lease(h, "acquire");
  await write(text);
  await Bun.sleep(400);
  await write("\r");
}
const idle = (h: Hosted, ms = 180000) => until(`${h.name} turn end`, async () => (await term(h))?.progress === "idle", ms);
const busy = (h: Hosted) => until(`${h.name} turn start`, async () => (await term(h))?.progress === "busy", 30000);
const transcriptFile = (h: Hosted) => (sessionJournal(h.session).readAll().findLast((e) => e.type === "run.started")?.payload as any)?.transcript_path as string | null;
function transcript(h: Hosted, role: "assistant" | "user"): string[] {
  const f = transcriptFile(h);
  if (!f || !existsSync(f)) return [];
  const out: string[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    try {
      const r = JSON.parse(l);
      if (r.type !== role) continue;
      const c = r.message?.content;
      if (typeof c === "string") out.push(c);
      else for (const x of c ?? []) if (x.type === "text") out.push(x.text);
    } catch {}
  }
  return out;
}
const replied = (h: Hosted, token: string, ms = 120000) => until(`${h.name} reply with ${token}`, () => transcript(h, "assistant").some((t) => t.includes(token)), ms).then(() => true, () => false);
const toolsUsed = (h: Hosted) => sessionJournal(h.session).readAll().filter((e) => e.type === "activity" && (e.payload as any).hook === "PreToolUse").map((e) => (e.payload as any).tool as string);
const routes = (h: Hosted, b: string) => state(h).work.batches[b]!.attempts.map((a) => `${a.route}:${a.outcome}`);
async function screen(h: Hosted): Promise<string> {
  // Rebuild the screen from ptyd's snapshot on demand.
  const xt = h.xt;
  return new Promise((res) => xt.write("", () => {
    const b = xt.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < xt.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    res(rows.filter((r) => r.trim()).join("\n"));
  }));
}

let ptyd = svc("ptyd");
let daemon = svc("daemon");
const suffix = crypto.randomUUID().slice(0, 4);
try {
  ctl = await until("ptyd", () => PtyClient.connect({ client: "cli" }));
  ctl.onPush((p: any) => {
    const h = hosted.find((x) => x.tid === p.terminal_id);
    if (!h) return;
    if (p.event === "snapshot_begin") (h.xt.reset(), h.xt.resize(p.cols, p.rows));
    else if (p.event === "snapshot_chunk" || p.event === "output") h.xt.write(b64.decode(p.data_b64));
    else if (p.event === "resize") h.xt.resize(p.cols, p.rows);
  });
  token = await until("ui token", () => readFileSync(join(HOME, "secrets/ui-token"), "utf8").trim());
  await until("daemon", () => api("GET", "/api/v1/sessions"));

  // ---------- 1. the real task ----------
  const M = await launch(`fm-exit-m-${suffix}`);
  await typePrompt(M, [
    "This is a planning exercise: do not edit, create or delete any file.",
    "Task: plan how to add a `lint` script to this repo's package.json (read package.json first).",
    "Follow the Foreman protocol from your contract, and make exactly these Foreman calls:",
    "(1) foreman_brief with a checklist (ids read, decide, handover).",
    "(2) foreman_post a decision with id `linter`: you chose Biome, the alternative is ESLint; impact med, reversibility easy.",
    "(3) foreman_ask id `ci`, policy proceed: whether to run lint in CI; options `yes` and `no`; default `yes`.",
    "(4) foreman_post an offer with id `precommit`: also add a pre-commit hook that runs lint; default skip.",
    "(5) foreman_ask id `dep`, policy block, reversibility costly: may you add a new devDependency for the linter; options `allow` and `deny`; default `deny`.",
    "Then END YOUR TURN at once: the blocking question means you wait for the human.",
    "When the human's answers arrive: handle every action, acknowledge each with foreman_inbox (seen, then acted), update the `linter` decision item if they ask you to reconsider it (resend its full content at its current revision), then write foreman_handover with the final plan.",
    "Keep terminal output to one short line per turn.",
  ].join(" "));
  await lease(M, "release");
  const items = () => state(M).work.items;
  const setUp = await until("brief + 4 items + blocking question left open", () => {
    const it = items();
    return state(M).work.brief && it.linter && it.ci && it.precommit && it.dep && !it.dep.resolved ? true : null;
  }, 300000).then(() => true, () => false);
  await idle(M);
  const it0 = items();
  check(
    "1a. real task: brief, decision, offer, proceed + blocking questions via MCP; the turn ended on the blocking question",
    setUp && it0.linter?.body.kind === "decision" && it0.precommit?.body.kind === "offer" && (it0.ci?.body as any)?.policy === "proceed" && (it0.dep?.body as any)?.policy === "block" && !it0.dep?.resolved,
    `items=${Object.keys(it0).join(",")} dep=${it0.dep?.resolved ? "resolved" : "open"}`,
  );

  // The human answers through the card's own routes: stage in the tray, then one Send.
  const detail = await api("GET", `/api/v1/sessions/${M.session}`);
  const rev = (id: string) => detail.work.items.find((i: any) => i.id === id)?.revision ?? it0[id]?.revision;
  const acts = [
    { type: "answer", action_id: crypto.randomUUID(), item_id: "dep", item_revision: rev("dep"), option_id: "allow" },
    { type: "answer", action_id: crypto.randomUUID(), item_id: "ci", item_revision: rev("ci"), option_id: "no", text: "Skip CI lint for now: CI minutes are tight this month." },
    { type: "revisit", action_id: crypto.randomUUID(), item_id: "linter", item_revision: rev("linter"), text: "Use ESLint instead: the team already knows it." },
    { type: "offer_accept", action_id: crypto.randomUUID(), item_id: "precommit", item_revision: rev("precommit") },
  ];
  const put = await api("PUT", `/api/v1/sessions/${M.session}/tray`, { expected_revision: detail.tray.revision, actions: acts });
  const sent = await api("POST", `/api/v1/sessions/${M.session}/send`, { batch_id: put.tray.batch_id, tray_revision: put.tray.revision });
  const batch1 = sent.batch_id as string;
  log(`sent batch ${batch1} (${acts.length} actions)`);
  const handled = await until("every action acted + handover", () => {
    const w = state(M).work;
    const b = w.batches[batch1];
    return b && acts.every((a) => b.acted[a.action_id]) && w.handover ? true : null;
  }, 360000).then(() => true, () => false);
  await idle(M).catch(() => {});
  const w1 = state(M).work;
  const b1 = w1.batches[batch1]!;
  check("1b. one Send carried answer + override + revisit + accept; the idle worker typed it", routes(M, batch1).join() === "idle_submit:transport_sent" && !!b1.corroborated_at, `routes=${routes(M, batch1)}`);
  const outcomes = acts.map((a) => `${a.item_id}:${b1.acted[a.action_id]?.outcome ?? "none"}`);
  check("1c. the agent acked every action (seen, then acted)", handled && !!b1.seen_at && acts.every((a) => b1.acted[a.action_id]), outcomes.join(" "));
  const linter = w1.items.linter!;
  check(
    "1d. outcomes recorded: answered questions closed, offer accepted, decision revised to ESLint, handover written",
    w1.items.dep?.resolved?.outcome === "answered" && w1.items.ci?.resolved?.outcome === "answered" && w1.items.precommit?.resolved?.outcome === "accepted" && linter.revision > it0.linter!.revision && /eslint/i.test((linter.body as any).chose ?? "") && !!w1.handover,
    `dep=${w1.items.dep?.resolved?.outcome} ci=${w1.items.ci?.resolved?.outcome} precommit=${w1.items.precommit?.resolved?.outcome} linter r${linter.revision} chose="${(linter.body as any).chose}" handover=${!!w1.handover}`,
  );
  if (w1.handover) log(`   handover: ${w1.handover.summary_md.replace(/\s+/g, " ").slice(0, 240)}`);

  // ---------- 2. uncertain holds the queue ----------
  await lease(M, "acquire"); // like a human with the terminal open: the idle worker must not type
  const x = crypto.randomUUID();
  createBatch(M.session, { batch_id: x, run: state(M).run!, kind: "send", actions: [{ type: "note", action_id: crypto.randomUUID(), text: "Reply with only: UNCERTAIN-X" }] });
  const claim = claimNext(M.session, "idle_submit")!;
  settle(claim, "uncertain", "demo: simulated crash between paste and confirmation");
  const y = crypto.randomUUID();
  createBatch(M.session, { batch_id: y, run: state(M).run!, kind: "send", actions: [{ type: "note", action_id: crypto.randomUUID(), text: "Reply with only: QUEUED-Y" }] });
  await typePrompt(M, "Use the Read tool to read LICENSE, then reply with only: READ-U");
  await replied(M, "READ-U");
  await idle(M);
  const heldView = (await api("GET", `/api/v1/sessions/${M.session}`)).session.delivery;
  check(
    "2a. an uncertain delivery holds the queue through a whole turn (no hook delivers past it)",
    batchStatus(state(M).work.batches[x]!) === "uncertain" && state(M).work.batches[y]!.attempts.length === 0 && heldView?.held?.reason === "uncertain",
    `x=${batchStatus(state(M).work.batches[x]!)} y-attempts=${state(M).work.batches[y]!.attempts.length} held=${heldView?.held?.reason}`,
  );
  await api("POST", `/api/v1/sessions/${M.session}/batches/${x}/retry`);
  await lease(M, "release");
  const okX = await replied(M, "UNCERTAIN-X");
  const okY = await replied(M, "QUEUED-Y");
  await idle(M);
  check("2b. only the explicit Retry moves it: X re-delivered, then Y in order", okX && okY && batchStatus(state(M).work.batches[y]!) !== "queued", `x=${routes(M, x)} y=${routes(M, y)}`);

  // ---------- 3. daemon down ----------
  daemon.kill("SIGTERM");
  await daemon.exited;
  const z = crypto.randomUUID();
  createBatch(M.session, { batch_id: z, run: state(M).run!, kind: "send", actions: [{ type: "note", action_id: crypto.randomUUID(), text: "Also include the word DAEMONLESS-Z in your final reply." }] });
  const seqBefore = state(M).last_seq;
  await typePrompt(M, "Call foreman_progress (progress 95, confidence high, now: daemon-off check), then use the Read tool to read LICENSE, then reply with only: READ-Z");
  const okZ = await replied(M, "DAEMONLESS-Z");
  await idle(M);
  const progressLanded = sessionJournal(M.session).readAll().some((e) => e.seq > seqBefore && e.type === "progress.set" && /daemon-off/i.test((e.payload as any).now));
  check("3. foremand down: the MCP call persisted and PostToolUse still delivered the batch", okZ && progressLanded && routes(M, z).join() === "post_tool_use:transport_sent", `progress=${progressLanded} z=${routes(M, z)}`);
  await lease(M, "release");
  daemon = svc("daemon");
  await until("daemon back", () => api("GET", "/api/v1/sessions"));

  // ---------- 4. Stop on a real turn ----------
  await typePrompt(M, "Without using any tool, write every number from 1 to 400, one per line, then the word COUNT-DONE.");
  await lease(M, "release");
  await busy(M);
  await Bun.sleep(2500);
  await until("daemon sees the busy terminal", async () => (await api("GET", `/api/v1/sessions/${M.session}`)).session.terminal_progress === "busy", 10000);
  const t0 = Date.now();
  await api("POST", `/api/v1/sessions/${M.session}/stop`, { request_id: crypto.randomUUID() });
  const stopped = await until("idle after Stop", async () => (await term(M))?.progress === "idle", 10000).then(() => true, () => false);
  const ms = Date.now() - t0;
  await Bun.sleep(1500);
  const tm = await term(M);
  const view = (await api("GET", `/api/v1/sessions/${M.session}`)).session;
  check("4. Stop ended a real streaming turn; process and conversation kept", stopped && tm?.state === "live" && state(M).state !== "dead" && !transcript(M, "assistant").some((t) => t.includes("COUNT-DONE")) && !!view.stop, `idle after ${ms} ms, draft=${view.stop?.draft ?? null}`);

  // ---------- 5. peers ----------
  const P = await launch(`fm-exit-p-${suffix}`);
  const seenByP = readPeers({ session: P.session, native_id: state(P).native_id, project: state(P).project }, 1000).peers.find((p) => p.session === M.session);
  check("5a. P's peer snapshot (the one its contract got) shows M with its verified name and goal", seenByP?.name === M.name && !!seenByP?.goal, `name=${seenByP?.name} goal="${seenByP?.goal}"`);
  const ping = `PEER-PING-${suffix}`;
  await typePrompt(P, `Call foreman_peers, then reply with one line starting PEERS: that gives the name and goal of each peer. Then use ListAgents to find the local session named exactly ${M.name}, and use SendMessage to send it exactly this text: ${ping}. Message no other session. Then reply with only: SENT`);
  await lease(P, "release");
  const okP = await replied(P, "SENT", 150000);
  const peersLine = transcript(P, "assistant").find((t) => t.includes("PEERS:")) ?? "";
  check("5b. P called foreman_peers and read M's goal from it", toolsUsed(P).some((t) => t.endsWith("foreman_peers")) && peersLine.includes(M.name), peersLine.replace(/\s+/g, " ").slice(0, 200));
  const got = await until("M receives the peer message", () => transcript(M, "user").find((t) => t.includes(ping)), 90000).then(() => true, () => false);
  check("5c. native SendMessage reached M (a cross-session message)", okP && got && toolsUsed(P).includes("SendMessage"), `P tools=${toolsUsed(P).filter((t) => !t.startsWith("mcp__")).join(",")}`);
  await idle(M, 120000).catch(() => {});

  // ---------- 6. duplicate claims ----------
  let dup = 0;
  let total = 0;
  for (const h of hosted) {
    for (const b of Object.values(state(h).work.batches)) {
      total++;
      const live = b.attempts.filter((a) => a.seq > (b.retry_seq ?? 0) && a.outcome !== "failed");
      if (live.length > 1) dup++;
    }
  }
  check("6. no batch has two live delivery claims (outside an explicit Retry)", dup === 0, `${total} batches, ${dup} duplicates`);
} catch (err) {
  check("demo ran to completion", false, (err as Error).message);
  for (const h of hosted) console.log(`--- ${h.name} ---\n${await screen(h)}`);
} finally {
  for (const h of hosted) await ctl?.request({ op: "kill", terminal_id: h.tid }).catch(() => {});
  ctl?.close();
  await Bun.sleep(1000);
  daemon.kill("SIGTERM");
  ptyd.kill("SIGTERM");
  await Promise.all([daemon.exited, ptyd.exited]);
}
const failed = results.filter((r) => !r).length;
log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
