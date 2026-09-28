// ptyd behaviour over its real socket: snapshots, replay, leases, slow viewers, exits.
// Children are /bin/sh and cat, never a real Claude.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Terminal as XTerm } from "@xterm/headless";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PtyClient, PtyError } from "../src/shared/ptyclient";
import { b64, type Push, type TerminalInfo } from "../src/shared/ptyproto";
import { startPtyd, type PtydServer } from "../src/ptyd/server";

let dir: string;
let sock: string;
let server: PtydServer;
const clients: PtyClient[] = [];

beforeAll(async () => {
  dir = mkdtempSync("/tmp/fm-ptyd-"); // short path: Unix socket paths are length-limited
  process.env.FOREMAN_HOME = dir;
  sock = join(dir, "ptyd.sock");
  server = await startPtyd({ socket: sock, writeRecord: false });
});

afterAll(() => {
  for (const c of clients) c.close();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(client: "cli" | "daemon" = "cli"): Promise<PtyClient> {
  const c = await PtyClient.connect({ client, socket: sock });
  clients.push(c);
  return c;
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function create(c: PtyClient, script: string, extra: { cols?: number; rows?: number; request_id?: string } = {}): Promise<TerminalInfo> {
  const r = await c.request<{ terminal: TerminalInfo }>({
    op: "create",
    request_id: extra.request_id ?? crypto.randomUUID(),
    cwd: dir,
    argv: ["/bin/sh", "-c", script],
    cols: extra.cols ?? 80,
    rows: extra.rows ?? 24,
  });
  return r.terminal;
}

/** A viewer that mirrors the ordered stream into its own headless emulator. */
class Mirror {
  xt = new XTerm({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 10000 });
  viewerId = crypto.randomUUID();
  seq = 0;
  epoch = "";
  exit: Push | null = null;
  writer: string | null = null;
  resynced = false;
  mode = "";

  constructor(
    public c: PtyClient,
    public id: string,
  ) {
    c.onPush((p) => {
      if (!("terminal_id" in p) || p.terminal_id !== id) return;
      switch (p.event) {
        case "snapshot_begin":
          this.xt.reset();
          this.xt.resize(p.cols, p.rows);
          this.epoch = p.stream_epoch;
          break;
        case "snapshot_chunk":
          this.xt.write(b64.decode(p.data_b64));
          break;
        case "snapshot_end":
          this.seq = p.seq;
          break;
        case "output":
          this.xt.write(b64.decode(p.data_b64));
          this.seq = p.seq;
          this.epoch = p.stream_epoch;
          break;
        case "resize": {
          const { cols, rows } = p;
          this.xt.write("", () => this.xt.resize(cols, rows));
          this.seq = p.seq;
          break;
        }
        case "exit":
          this.exit = p;
          this.seq = p.seq;
          break;
        case "control":
          this.writer = p.writer;
          break;
        case "resync_required":
          this.resynced = true;
          break;
      }
    });
  }

  async attach(afterSeq?: number, epoch?: string): Promise<this> {
    const r = await this.c.request<{ mode: string }>({ op: "attach", terminal_id: this.id, viewer_id: this.viewerId, after_seq: afterSeq, stream_epoch: epoch });
    this.mode = r.mode;
    return this;
  }

  settle(): Promise<void> {
    return new Promise((r) => this.xt.write("", r));
  }

  async text(): Promise<string> {
    await this.settle();
    const b = this.xt.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)!.translateToString(true));
    return lines.join("\n").trimEnd();
  }

  control(action: "acquire" | "release" | "takeover") {
    return this.c.request<{ writer: string | null }>({ op: "control", terminal_id: this.id, viewer_id: this.viewerId, action });
  }

  write(s: string) {
    return this.c.request({ op: "write", terminal_id: this.id, viewer_id: this.viewerId, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode(s)) });
  }
}

async function lastSeq(c: PtyClient, id: string): Promise<number> {
  const { terminals } = await c.request<{ terminals: TerminalInfo[] }>({ op: "list" });
  return terminals.find((t) => t.terminal_id === id)!.last_seq;
}

describe("ptyd", () => {
  test("protocol errors are explicit: hello first, version, unknown op", async () => {
    const raw = await new Promise<string>((resolve) => {
      const s = createConnection(sock);
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.split("\n").length > 3) {
          s.destroy();
          resolve(buf);
        }
      });
      s.write(JSON.stringify({ v: 1, id: "a", op: "list" }) + "\n");
      s.write(JSON.stringify({ v: 2, id: "b", op: "hello", client: "cli" }) + "\n");
      s.write(JSON.stringify({ v: 1, id: "c", op: "hello", client: "cli" }) + "\n");
      s.write(JSON.stringify({ v: 1, id: "d", op: "frobnicate" }) + "\n");
    });
    const codes = raw.trim().split("\n").map((l) => JSON.parse(l)).map((f) => f.ok || f.error.code);
    expect(codes).toEqual(["BAD_REQUEST", "UNSUPPORTED_VERSION", true, "UNKNOWN_OP"]);
  });

  test("create is idempotent by request_id and validates input", async () => {
    const c = await connect();
    const request_id = crypto.randomUUID();
    const a = await create(c, "sleep 5", { request_id });
    const b = await create(c, "sleep 5", { request_id });
    expect(b.terminal_id).toBe(a.terminal_id);
    await expect(c.request({ op: "create", request_id: crypto.randomUUID(), cwd: "relative", argv: ["x"], cols: 80, rows: 24 })).rejects.toThrow(/absolute/);
    await expect(c.request({ op: "create", request_id: crypto.randomUUID(), cwd: dir, argv: ["x"], cols: 5, rows: 24 })).rejects.toThrow(/cols/);
    await c.request({ op: "kill", terminal_id: a.terminal_id, signal: "SIGKILL" });
  });

  test("a late snapshot viewer sees exactly what a from-the-start viewer sees, including alt screen and modes", async () => {
    const c = await connect();
    // Child hides a normal-screen line under the alt screen and turns on paste + app-cursor modes.
    const t = await create(c, 'printf "normal-screen\\r\\n"; sleep 0.2; printf "\\033[?1049h\\033[?2004h\\033[?1h\\033[2J\\033[3;5Hhello alt \\342\\234\\223"; sleep 30');
    const live = await new Mirror(c, t.terminal_id).attach();
    await until(async () => (await live.text()).includes("hello alt"), 5000, "alt output");
    const late = await new Mirror(await connect(), t.terminal_id).attach();
    expect(late.mode).toBe("snapshot");
    await until(async () => (await late.text()) === (await live.text()), 3000, "snapshot == live");
    expect(late.xt.buffer.active.type).toBe("alternate");
    expect(late.xt.modes.bracketedPasteMode).toBe(true);
    expect(late.xt.modes.applicationCursorKeysMode).toBe(true);
    expect(await late.text()).toContain("hello alt ✓");
    await c.request({ op: "kill", terminal_id: t.terminal_id, signal: "SIGKILL" });
  });

  test("a UTF-8 character split across two PTY chunks renders once, correctly", async () => {
    const c = await connect();
    const t = await create(c, 'printf "\\303"; sleep 0.3; printf "\\251t\\351\\r\\n"; sleep 30');
    const m = await new Mirror(c, t.terminal_id).attach();
    await until(async () => (await m.text()).includes("ét"), 5000, "split char");
    const late = await new Mirror(await connect(), t.terminal_id).attach();
    await until(async () => (await late.text()).includes("ét"), 3000, "split char in snapshot");
    await c.request({ op: "kill", terminal_id: t.terminal_id, signal: "SIGKILL" });
  });

  test("writer lease: write needs control, acquire respects the holder, takeover is explicit", async () => {
    const ca = await connect();
    const cb = await connect();
    const t = await create(ca, "exec cat");
    const a = await new Mirror(ca, t.terminal_id).attach();
    const b = await new Mirror(cb, t.terminal_id).attach();
    await expect(a.write("x")).rejects.toMatchObject({ code: "NOT_WRITER" });
    expect((await a.control("acquire")).writer).toBe(a.viewerId);
    expect((await b.control("acquire")).writer).toBe(a.viewerId); // held: b stays read-only
    await a.write("from-a\r");
    await until(async () => (await b.text()).includes("from-a"), 3000, "echo of a");
    expect((await b.control("takeover")).writer).toBe(b.viewerId);
    await until(() => a.writer === b.viewerId, 2000, "control push to a");
    await expect(a.write("y")).rejects.toBeInstanceOf(PtyError);
    await b.write("from-b\r");
    await until(async () => (await a.text()).includes("from-b"), 3000, "echo of b");
    await ca.request({ op: "kill", terminal_id: t.terminal_id, signal: "SIGKILL" });
  });

  test("two viewers agree after resize, reconnect-by-replay and reconnect-by-snapshot", async () => {
    const ca = await connect();
    const t = await create(ca, "exec cat", { cols: 100, rows: 30 });
    const a = await new Mirror(ca, t.terminal_id).attach();
    await a.control("acquire");
    let cb = await connect();
    const b = await new Mirror(cb, t.terminal_id).attach();
    for (let i = 0; i < 40; i++) await a.write(`line ${i} ${"#".repeat(i)}\r`);
    await ca.request({ op: "resize", terminal_id: t.terminal_id, viewer_id: a.viewerId, cols: 60, rows: 20 });
    await until(async () => (await a.text()) === (await b.text()) && b.xt.cols === 60, 3000, "b follows resize");

    // b drops, output continues, b comes back with its cursor: deltas only.
    const [bSeq, bEpoch] = [b.seq, b.epoch];
    cb.close();
    for (let i = 40; i < 50; i++) await a.write(`more ${i}\r`);
    cb = await connect();
    const b2 = new Mirror(cb, t.terminal_id);
    b2.xt = b.xt;
    await b2.attach(bSeq, bEpoch);
    expect(b2.mode).toBe("replay");
    await until(async () => (await a.text()) === (await b2.text()), 3000, "replay converges");

    // A stale epoch forces a snapshot.
    const c3 = await new Mirror(await connect(), t.terminal_id).attach(bSeq, crypto.randomUUID());
    expect(c3.mode).toBe("snapshot");
    await until(async () => (await a.text()) === (await c3.text()), 3000, "snapshot converges");
    expect(c3.xt.cols).toBe(60);
    await ca.request({ op: "kill", terminal_id: t.terminal_id, signal: "SIGKILL" });
  });

  test("a viewer that stops reading is dropped with resync; the child and other viewers carry on", async () => {
    const c = await connect("daemon");
    const t = await create(c, "sleep 0.5; head -c 3000000 /dev/zero | tr '\\0' 'x'; printf '\\r\\nDONE\\r\\n'; sleep 30", { cols: 200, rows: 50 });
    const good = await new Mirror(c, t.terminal_id).attach();
    // Raw consumer that attaches and then never reads.
    const slow = createConnection(sock);
    await new Promise<void>((r) => slow.once("connect", () => r()));
    slow.write(JSON.stringify({ v: 1, id: "h", op: "hello", client: "cli" }) + "\n");
    slow.write(JSON.stringify({ v: 1, id: "a", op: "attach", terminal_id: t.terminal_id, viewer_id: crypto.randomUUID() }) + "\n");
    await Bun.sleep(100);
    slow.pause();
    const viewers = async () => {
      const { terminals } = await c.request<{ terminals: TerminalInfo[] }>({ op: "list" });
      return terminals.find((x) => x.terminal_id === t.terminal_id)!;
    };
    await until(async () => (await viewers()).viewers === 2, 2000, "slow viewer attached");
    await until(async () => (await good.text()).includes("DONE"), 10000, "good viewer got all output");
    const info = await viewers();
    expect(info.viewers).toBe(1); // slow one detached
    expect(info.state).toBe("live");
    slow.destroy();
    await c.request({ op: "kill", terminal_id: t.terminal_id, signal: "SIGKILL" });
  }, 20000);

  test("exit events carry the process exit code or signal, and daemon connections hear lifecycle pushes", async () => {
    const c = await connect("daemon");
    const events: TerminalInfo[] = [];
    c.onPush((p) => {
      if (p.event === "terminal") events.push(p.terminal);
    });
    const t1 = await create(c, "sleep 0.3; exit 3");
    const m1 = await new Mirror(c, t1.terminal_id).attach();
    await until(() => m1.exit !== null, 5000, "exit 3");
    expect(m1.exit).toMatchObject({ code: 3, signal: null });

    const t2 = await create(c, "sleep 30");
    const m2 = await new Mirror(c, t2.terminal_id).attach();
    await c.request({ op: "kill", terminal_id: t2.terminal_id, signal: "SIGKILL" });
    await until(() => m2.exit !== null, 5000, "killed");
    expect((m2.exit as any).signal).toBe("SIGKILL");
    expect(events.some((e) => e.terminal_id === t1.terminal_id && e.state === "exited")).toBe(true);

    // Exited terminals stay listed and viewable.
    const late = await new Mirror(c, t1.terminal_id).attach();
    await until(() => late.exit !== null || late.seq > 0, 2000, "late view of exited terminal");
    await expect(late.control("acquire")).rejects.toMatchObject({ code: "EXITED" });
  });

  test("bind is daemon-only compare-and-swap", async () => {
    const cli = await connect("cli");
    const d = await connect("daemon");
    const t = await create(cli, "sleep 30");
    const target = crypto.randomUUID();
    await expect(cli.request({ op: "bind", terminal_id: t.terminal_id, target, expected_target: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await d.request({ op: "bind", terminal_id: t.terminal_id, target, expected_target: null });
    await expect(d.request({ op: "bind", terminal_id: t.terminal_id, target: null, expected_target: null })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await lastSeq(d, t.terminal_id)).toBeGreaterThanOrEqual(0);
    await d.request({ op: "kill", terminal_id: t.terminal_id, signal: "SIGKILL" });
  });

  test("hosted children never inherit parent-agent variables", async () => {
    const c = await connect();
    const r = await c.request<{ terminal: TerminalInfo }>({
      op: "create",
      request_id: crypto.randomUUID(),
      cwd: dir,
      argv: ["/bin/sh", "-c", 'echo "[$CLAUDECODE|$CLAUDE_CODE_CHILD_SESSION|$CMUX_SURFACE_ID|$KEEP|${FOREMAN_TERMINAL_ID:+tid}|$TERM]"; sleep 30'],
      cols: 80,
      rows: 24,
      env: { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CMUX_SURFACE_ID: "x", KEEP: "kept", PATH: process.env.PATH! },
    });
    const m = await new Mirror(c, r.terminal.terminal_id).attach();
    await until(async () => (await m.text()).includes("]"), 3000, "env echo");
    expect(await m.text()).toContain("[|||kept|tid|xterm-256color]");
    await c.request({ op: "kill", terminal_id: r.terminal.terminal_id, signal: "SIGKILL" });
  });
});
