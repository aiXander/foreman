// Phase-1 exit evidence with REAL Claude processes, in an isolated FOREMAN_HOME:
//  1. five managed agents register (plugin hooks) and are bound to their runs
//  2. they survive a daemon restart and a browser (WebSocket) reconnect
//  3. two viewers agree after a resize and after a delta-replay reconnect
// Idle Claude TUIs cost nothing; no prompt is sent. Usage: bun scripts/phase1-demo.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal as XTerm } from "@xterm/headless";

const home = mkdtempSync(join(tmpdir(), "foreman-demo-"));
const port = 30000 + Math.floor(Math.random() * 20000);
process.env.FOREMAN_HOME = home;
process.env.FOREMAN_PORT = String(port);
const repo = join(import.meta.dir, "..");
const cli = join(repo, "src/cli/main.ts");

const { PtyClient } = await import("../src/shared/ptyclient");
const { b64 } = await import("../src/shared/ptyproto");
const { pluginDir, resolveClaude } = await import("../src/shared/config");
const { paths } = await import("../src/shared/paths");
const { readFileSync } = await import("node:fs");

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CMUX_|C11_)/.test(k)) delete env[k];
const spawnSvc = (cmd: string) => Bun.spawn(["bun", cli, cmd], { env, stdout: "ignore", stderr: "inherit" });

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

const ptyd = spawnSvc("ptyd");
let daemon = spawnSvc("daemon");
const origin = `http://127.0.0.1:${port}`;
const bearer = () => ({ Authorization: `Bearer ${readFileSync(paths.uiToken(), "utf8").trim()}` });
const sessions = async () => (await (await fetch(`${origin}/api/v1/sessions`, { headers: bearer() })).json()) as any;
const terminalIds: string[] = [];
let ctl: Awaited<ReturnType<typeof PtyClient.connect>> | null = null;

try {
  ctl = await until("ptyd", () => PtyClient.connect({ client: "cli" }));
  await until("daemon", () => sessions());

  const claude = resolveClaude();
  for (let i = 0; i < 5; i++) {
    const { terminal } = await ctl.request<any>({
      op: "create",
      request_id: crypto.randomUUID(),
      cwd: repo,
      argv: [claude, "--plugin-dir", pluginDir(), "--model", "haiku"],
      cols: 100,
      rows: 30,
      env: env as Record<string, string>,
    });
    terminalIds.push(terminal.terminal_id);
  }

  const managedLive = (r: any) =>
    r.sessions.filter((s: any) => s.mode === "managed" && s.process === "alive" && terminalIds.includes(s.terminal_id));
  const five = await until("5 registered managed sessions", async () => {
    const r = await sessions();
    return managedLive(r).length === 5 ? r : null;
  }, 45000);
  check("five managed agents registered via plugin hooks", true, managedLive(five).map((s: any) => s.state).join(","));
  const bound = await until("targets bound in ptyd", async () => {
    const { terminals } = await ctl!.request<any>({ op: "list" });
    const mine = terminals.filter((t: any) => terminalIds.includes(t.terminal_id));
    return mine.every((t: any) => t.target) ? mine : null;
  });
  check("each terminal routed to its session's run", bound.length === 5);

  // Daemon restart: agents live in ptyd and must be untouched.
  const pidsBefore = bound.map((t: any) => t.pid).sort().join(",");
  daemon.kill("SIGTERM");
  await daemon.exited;
  const { terminals: during } = await ctl.request<any>({ op: "list" });
  check("agents alive while daemon is down", during.filter((t: any) => terminalIds.includes(t.terminal_id) && t.state === "live").length === 5);
  daemon = spawnSvc("daemon");
  const after = await until("daemon back with 5 live sessions", async () => {
    const r = await sessions();
    return managedLive(r).length === 5 ? r : null;
  });
  const pidsAfter = after.terminals.filter((t: any) => terminalIds.includes(t.terminal_id)).map((t: any) => t.pid).sort().join(",");
  check("five agents survive daemon restart (same PIDs)", pidsBefore === pidsAfter);

  // Two viewers: A controls and resizes; B follows via snapshot; B reconnects via delta replay.
  const tid = terminalIds[0]!;
  const mkViewer = async () => {
    const c = await PtyClient.connect({ client: "cli" });
    const vid = crypto.randomUUID();
    const state = { xt: new XTerm({ cols: 100, rows: 30, allowProposedApi: true }), seq: 0, epoch: "" };
    let snap: Uint8Array[] = [];
    c.onPush((p: any) => {
      if (p.terminal_id !== tid) return;
      if (p.event === "snapshot_begin") {
        state.xt.reset();
        state.xt.resize(p.cols, p.rows);
        state.epoch = p.stream_epoch;
        snap = [];
      } else if (p.event === "snapshot_chunk") snap.push(b64.decode(p.data_b64));
      else if (p.event === "snapshot_end") {
        for (const s of snap) state.xt.write(s);
        state.seq = p.seq;
      } else if (p.event === "output") {
        state.xt.write(b64.decode(p.data_b64));
        state.seq = p.seq;
        state.epoch = p.stream_epoch;
      } else if (p.event === "resize") {
        state.xt.resize(p.cols, p.rows);
        state.seq = p.seq;
      }
    });
    return { c, vid, state };
  };
  const text = (xt: XTerm) =>
    new Promise<string>((res) =>
      xt.write("", () => {
        const b = xt.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < xt.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
        res(lines.join("\n").trimEnd());
      }),
    );
  const A = await mkViewer();
  const B = await mkViewer();
  await A.c.request({ op: "attach", terminal_id: tid, viewer_id: A.vid });
  await B.c.request({ op: "attach", terminal_id: tid, viewer_id: B.vid });
  await A.c.request({ op: "control", terminal_id: tid, viewer_id: A.vid, action: "acquire" });
  await A.c.request({ op: "resize", terminal_id: tid, viewer_id: A.vid, cols: 84, rows: 26 });
  await Bun.sleep(2500); // let Claude redraw at the new size
  const [ta, tb] = [await text(A.state.xt), await text(B.state.xt)];
  check("two viewers agree after resize", ta === tb && ta.includes("Claude Code"), `${A.state.xt.cols}x${A.state.xt.rows}`);

  const { seq, epoch } = B.state;
  B.c.close();
  await A.c.request({ op: "write", terminal_id: tid, viewer_id: A.vid, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode("hello from viewer A")) });
  await Bun.sleep(1500);
  const B2 = await mkViewer();
  // Reuse B's emulator so replay applies on top of what B already had.
  B2.state.xt = B.state.xt;
  const r = await B2.c.request<any>({ op: "attach", terminal_id: tid, viewer_id: B2.vid, after_seq: seq, stream_epoch: epoch });
  await Bun.sleep(1000);
  const [ta2, tb2] = [await text(A.state.xt), await text(B2.state.xt)];
  check("reconnect by delta replay converges", r.mode === "replay" && ta2 === tb2 && ta2.includes("hello from viewer A"), `mode=${r.mode}`);
  // Clear the draft we typed so the agent is left at a blank prompt.
  await A.c.request({ op: "write", terminal_id: tid, viewer_id: A.vid, input_id: crypto.randomUUID(), data_b64: b64.encode(new Uint8Array([0x15])) });
  A.c.close();
  B2.c.close();

  // Browser path: signed-in WebSocket through the daemon, then reconnect with after_seq.
  const tok = (await (await fetch(`${origin}/api/v1/auth/launch-token`, { method: "POST", headers: bearer() })).json()) as any;
  const cookie = (await fetch(tok.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
  const wsOnce = (q: string) =>
    new Promise<{ frames: any[] }>((res, rej) => {
      const frames: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/terminals/${tid}/ws${q}`, { headers: { Cookie: cookie, Origin: origin } } as any);
      ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
      ws.onerror = () => rej(new Error("ws error"));
      setTimeout(() => {
        ws.close();
        res({ frames });
      }, 1500);
    });
  const w1 = await wsOnce("");
  const hasSnap = w1.frames.some((f) => f.t === "snapshot_end");
  const lastSeq = Math.max(...w1.frames.map((f) => f.seq ?? 0));
  const ep = w1.frames.find((f) => f.t === "snapshot_begin")?.stream_epoch;
  const w2 = await wsOnce(`?after_seq=${lastSeq}&stream_epoch=${ep}`);
  check("browser WS: snapshot on first attach, replay (no snapshot) on reconnect", hasSnap && !w2.frames.some((f) => f.t === "snapshot_begin"), `${w1.frames.length}/${w2.frames.length} frames`);
} catch (e) {
  check("demo completed", false, (e as Error).message);
} finally {
  for (const id of terminalIds) await ctl?.request({ op: "kill", terminal_id: id }).catch(() => {});
  await Bun.sleep(500);
  ctl?.close();
  daemon.kill("SIGTERM");
  ptyd.kill("SIGTERM");
  await Promise.all([daemon.exited, ptyd.exited]);
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
}
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
