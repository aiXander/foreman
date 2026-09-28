// ptyd idle delivery (`input_state` / `submit`) over the real socket, against a fake Claude input
// box (test/fixtures/fake-claude.ts). The real-Claude evidence lives in scripts/spike/gate1-idle.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PtyClient, PtyError } from "../src/shared/ptyclient";
import { b64, type InputState, type SubmitResult, type TerminalInfo } from "../src/shared/ptyproto";
import { startPtyd, type PtydServer } from "../src/ptyd/server";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
let dir: string;
let server: PtydServer;
let daemon: PtyClient;
let cli: PtyClient;

beforeAll(async () => {
  dir = mkdtempSync("/tmp/fm-sub-");
  process.env.FOREMAN_HOME = dir;
  server = await startPtyd({ socket: join(dir, "ptyd.sock"), writeRecord: false });
  daemon = await PtyClient.connect({ client: "daemon", socket: join(dir, "ptyd.sock") });
  cli = await PtyClient.connect({ client: "cli", socket: join(dir, "ptyd.sock") });
});

afterAll(() => {
  daemon.close();
  cli.close();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(fn: () => Promise<T | null | false> | T | null | false, label: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

interface Fake {
  id: string;
  target: string;
  viewer: string;
  records: () => any[];
  state: () => Promise<InputState>;
  submit: (text: string, over?: Partial<{ epoch: number; target: string; attempt: string; lead: string }>) => Promise<SubmitResult>;
  type: (s: string) => Promise<void>;
}

async function fake(mode = "normal"): Promise<Fake> {
  const record = join(dir, `${crypto.randomUUID()}.jsonl`);
  const { terminal } = await daemon.request<{ terminal: TerminalInfo }>({
    op: "create",
    request_id: crypto.randomUUID(),
    cwd: dir,
    argv: [process.execPath, FAKE, record, mode],
    cols: 80,
    rows: 24,
  });
  const target = crypto.randomUUID();
  await daemon.request({ op: "bind", terminal_id: terminal.terminal_id, target, expected_target: null });
  const viewer = crypto.randomUUID();
  await cli.request({ op: "attach", terminal_id: terminal.terminal_id, viewer_id: viewer });
  const f: Fake = {
    id: terminal.terminal_id,
    target,
    viewer,
    records: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    state: () => daemon.request<InputState>({ op: "input_state", terminal_id: terminal.terminal_id }),
    submit: async (text, over = {}) =>
      daemon.request<SubmitResult>({
        op: "submit",
        terminal_id: terminal.terminal_id,
        target: over.target ?? target,
        attempt_id: over.attempt ?? crypto.randomUUID(),
        expected_input_epoch: over.epoch ?? (await f.state()).input_epoch,
        lead: over.lead ?? "[foreman batch b1] From the human:",
        text,
      }),
    type: async (s) => {
      await cli.request({ op: "control", terminal_id: terminal.terminal_id, viewer_id: viewer, action: "acquire" });
      await cli.request({ op: "write", terminal_id: terminal.terminal_id, viewer_id: viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode(s)) });
      await cli.request({ op: "control", terminal_id: terminal.terminal_id, viewer_id: viewer, action: "release" });
    },
  };
  return f;
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof PtyError ? e.code : String(e)));
const ready = (f: Fake) => until(async () => ((await f.state()).ready ? true : null), "ready");

describe("input_state", () => {
  test("ready only on an idle, empty prompt; drafts and dialogs block with a reason", async () => {
    const f = await fake();
    await ready(f);
    await f.type("half typed");
    const d = await until(async () => ((await f.state()).reason?.includes("draft") ? f.state() : null), "draft");
    expect(d.ready).toBe(false);
    await f.type("\x15");
    await ready(f);
    // With the cursor on a continuation row, a multi-line draft is still a draft, not "no prompt".
    await f.type("\x1b[200~first\nsecond\x1b[201~");
    const m = await until(async () => ((await f.state()).reason !== null ? f.state() : null), "multi-line draft");
    expect(m.reason).toContain("draft");

    const g = await fake("dialog");
    const s = await until(async () => ((await g.state()).progress === "busy" ? g.state() : null), "busy");
    expect(s.ready).toBe(false);
    expect(s.reason).toContain("busy");
  });

  test("is daemon-only", async () => {
    const f = await fake();
    expect(await code(cli.request({ op: "input_state", terminal_id: f.id }))).toBe("FORBIDDEN");
    expect(await code(cli.request({ op: "submit", terminal_id: f.id, target: f.target, attempt_id: crypto.randomUUID(), expected_input_epoch: 0, lead: "x", text: "y" }))).toBe("FORBIDDEN");
  });
});

describe("submit", () => {
  test("pastes lead and body as two bracketed pastes, submits once, and reports the turn", async () => {
    const f = await fake();
    await ready(f);
    const body = "line one\nZweite Zeile: héllo — 日本語 🚀\n\tindented";
    const r = await f.submit(body);
    expect(r.status).toBe("submitted");
    expect(r.stage).toBeNull();
    expect(f.records()).toEqual([{ paste: "[foreman batch b1] From the human:\n" }, { paste: body }, { submitted: `[foreman batch b1] From the human:\n${body}` }]);
    await ready(f); // the fake returns to idle; readiness recovers without any write from us
  });

  test("refuses before writing anything: draft, stale epoch, stale target, held lease", async () => {
    const f = await fake();
    await ready(f);
    const epoch = (await f.state()).input_epoch;
    expect(await code(f.submit("x", { target: crypto.randomUUID() }))).toBe("CONFLICT");
    await f.type("d");
    expect(await code(f.submit("x", { epoch }))).toBe("CONFLICT"); // typed after the reading
    expect(await code(f.submit("x"))).toBe("NOT_READY"); // current epoch, but the box holds "d"
    await f.type("\x7f");
    await ready(f);
    await cli.request({ op: "control", terminal_id: f.id, viewer_id: f.viewer, action: "acquire" });
    expect(await code(f.submit("x"))).toBe("CONFLICT");
    await cli.request({ op: "control", terminal_id: f.id, viewer_id: f.viewer, action: "release" });
    expect(f.records().filter((r) => r.paste !== undefined && r.paste !== "d")).toEqual([]);
    expect(f.records().some((r) => r.submitted)).toBe(false);
  });

  test("rejects text that could escape the paste frame or switch prompt modes", async () => {
    const f = await fake();
    await ready(f);
    expect(await code(f.submit("a\x1b[201~\rb"))).toBe("BAD_REQUEST");
    expect(await code(f.submit("fine", { lead: "/clear" }))).toBe("BAD_REQUEST");
    expect(await code(f.submit("fine", { lead: "two\nlines" }))).toBe("BAD_REQUEST");
    expect(await code(f.submit("é".repeat(8 * 1024 + 1)))).toBe("LIMIT");
    expect(f.records()).toEqual([]);
  });

  test("a retried attempt returns the first outcome without pasting again", async () => {
    const f = await fake();
    await ready(f);
    const attempt = crypto.randomUUID();
    const first = await f.submit("once", { attempt });
    const again = await f.submit("once", { attempt, epoch: 0 });
    expect(again).toEqual(first);
    expect(f.records().filter((r) => r.submitted)).toHaveLength(1);
  });

  test("viewer writes are refused while a submit is typing", async () => {
    const f = await fake("slow");
    await ready(f);
    const pending = f.submit("slow body");
    await until(() => f.records().length > 0, "first paste");
    await cli.request({ op: "control", terminal_id: f.id, viewer_id: f.viewer, action: "acquire" });
    const w = await code(cli.request({ op: "write", terminal_id: f.id, viewer_id: f.viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode("z")) }));
    await cli.request({ op: "control", terminal_id: f.id, viewer_id: f.viewer, action: "release" });
    expect(w).toBe("CONFLICT");
    expect((await pending).status).toBe("submitted");
  });

  test("a paste the TUI never shows is reported uncertain", async () => {
    const f = await fake("deaf"); // draws an idle prompt, then ignores all input
    await ready(f);
    const r = await f.submit("lost");
    expect(r).toMatchObject({ status: "uncertain", stage: "echo", start_ms: null });
  }, 10000);
});

describe("interrupt (Stop)", () => {
  const interrupt = (f: Fake, over: Partial<{ target: string; id: string }> = {}, client = daemon) =>
    client.request<{ interrupted: true; input_epoch: number }>({ op: "interrupt", terminal_id: f.id, target: over.target ?? f.target, interrupt_id: over.id ?? crypto.randomUUID() });
  const escs = (f: Fake) => f.records().filter((r) => r.esc).length;

  test("refused on an idle prompt, for a stale target and from a CLI client; nothing is written", async () => {
    const f = await fake();
    await ready(f);
    expect(await code(interrupt(f))).toBe("NOT_READY");
    expect(await code(interrupt(f, { target: crypto.randomUUID() }))).toBe("CONFLICT");
    expect(await code(interrupt(f, {}, cli))).toBe("FORBIDDEN");
    await Bun.sleep(100);
    expect(escs(f)).toBe(0);
  });

  test("one ESC into a busy turn; a retry is deduped, a Stop on the now-idle prompt is refused; the leftover draft is visible", async () => {
    const f = await fake("working");
    await until(async () => ((await f.state()).progress === "busy" ? true : null), "busy");
    const id = crypto.randomUUID();
    expect((await interrupt(f, { id })).interrupted).toBe(true);
    expect((await interrupt(f, { id })).interrupted).toBe(true); // same id: the first outcome, no second ESC
    const st = await until(async () => {
      const s = await f.state();
      return s.progress === "idle" && s.reason ? s : null;
    }, "idle with a draft");
    expect(st.reason).toContain("draft");
    expect(escs(f)).toBe(1);
    expect(await code(interrupt(f))).toBe("NOT_READY"); // idle now: never a second ESC
    expect(escs(f)).toBe(1);
  });
});
