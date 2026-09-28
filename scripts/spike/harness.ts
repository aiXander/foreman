// Phase-0 spike harness (throwaway): ptyd + foremand under FOREMAN_HOME=/tmp/fh, real Claude
// sessions launched through ptyd with the spike plugin, and helpers to read hooks, queue and
// transcripts. Only ever touches /tmp/fh.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal as XTerm } from "@xterm/headless";

export const FH = "/tmp/fh";
process.env.FOREMAN_HOME = FH;
process.env.FOREMAN_PORT = "7801";
export const SPIKE = join(FH, "spike");
export const REPO = join(import.meta.dir, "..", "..");
export const SPIKE_PLUGIN = join(import.meta.dir, "plugin");
export const CLAUDE = join(process.env.HOME!, ".local/bin/claude");

const { PtyClient } = await import("../../src/shared/ptyclient");
const { b64 } = await import("../../src/shared/ptyproto");
export { PtyClient, b64 };

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_|CMUX_|C11_)/.test(k)) env[k] = v;
export const cleanEnv = env;

export const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

export async function until<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 30000, poll = 100): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(poll);
  }
}

/** PASS/FAIL bookkeeping shared by the gate scripts; `done()` prints the tally and exits. */
export function gate() {
  const results: [string, boolean][] = [];
  return {
    check(name: string, ok: boolean, detail = ""): void {
      results.push([name, ok]);
      log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    },
    done(): never {
      const failed = results.filter((r) => !r[1]).length;
      log(`${results.length - failed}/${results.length} checks passed`);
      process.exit(failed ? 1 : 0);
    },
  };
}

export function setCtl(ctl: Record<string, unknown>): void {
  writeFileSync(join(SPIKE, "ctl.json"), JSON.stringify(ctl));
}

export function hooks(): any[] {
  const f = join(SPIKE, "hooks.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Assistant text blocks of a native session's transcript, in order. */
export function assistantTexts(native: string): string[] {
  const dir = join(process.env.HOME!, ".claude/projects", REPO.replace(/[^A-Za-z0-9]/g, "-"));
  const f = join(dir, `${native}.jsonl`);
  if (!existsSync(f)) return [];
  const out: string[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r.type === "assistant") for (const c of r.message?.content ?? []) if (c.type === "text") out.push(c.text);
    } catch {}
  }
  return out;
}

/** User messages (strings) of a native session's transcript. */
export function userTexts(native: string): string[] {
  const dir = join(process.env.HOME!, ".claude/projects", REPO.replace(/[^A-Za-z0-9]/g, "-"));
  const f = join(dir, `${native}.jsonl`);
  if (!existsSync(f)) return [];
  const out: string[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r.type === "user" && typeof r.message?.content === "string") out.push(r.message.content);
    } catch {}
  }
  return out;
}

export function startServices(): { stop: () => Promise<void> } {
  const cli = join(REPO, "src/cli/main.ts");
  const spawn = (cmd: string) => Bun.spawn(["bun", cli, cmd], { env: { ...env, FOREMAN_HOME: FH, FOREMAN_PORT: "7801" }, stdout: "ignore", stderr: "inherit" });
  const ptyd = spawn("ptyd");
  const daemon = spawn("daemon");
  return {
    async stop() {
      daemon.kill("SIGTERM");
      ptyd.kill("SIGTERM");
      await Promise.all([daemon.exited, ptyd.exited]);
    },
  };
}

type Client = Awaited<ReturnType<typeof PtyClient.connect>>;

/** A ptyd-hosted Claude plus a daemon-role client (input_state/submit) and a human viewer. */
export class Hosted {
  native = "";
  xt = new XTerm({ cols: 110, rows: 32, allowProposedApi: true });
  constructor(
    readonly daemon: Client,
    readonly human: Client,
    readonly id: string,
    readonly viewer: string,
  ) {
    let snap: Uint8Array[] = [];
    human.onPush((p: any) => {
      if (p.terminal_id !== id) return;
      if (p.event === "snapshot_begin") (this.xt.reset(), this.xt.resize(p.cols, p.rows), (snap = []));
      else if (p.event === "snapshot_chunk") snap.push(b64.decode(p.data_b64));
      else if (p.event === "snapshot_end") for (const c of snap) this.xt.write(c);
      else if (p.event === "output") this.xt.write(b64.decode(p.data_b64));
      else if (p.event === "resize") this.xt.resize(p.cols, p.rows);
    });
  }

  /** The human viewer's mirrored screen (non-blank rows). */
  screen(): Promise<string> {
    return new Promise((res) =>
      this.xt.write("", () => {
        const b = this.xt.buffer.active;
        const rows: string[] = [];
        for (let i = 0; i < this.xt.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
        res(rows.filter((r) => r.trim()).join("\n"));
      }),
    );
  }

  static async launch(extraArgs: string[] = [], name?: string): Promise<Hosted> {
    const daemon = await until("ptyd", () => PtyClient.connect({ client: "daemon" }));
    const human = await PtyClient.connect({ client: "cli" });
    const argv = [CLAUDE, "--plugin-dir", SPIKE_PLUGIN, "--model", "haiku", ...(name ? ["--name", name] : []), ...extraArgs];
    const { terminal } = await daemon.request<any>({ op: "create", request_id: crypto.randomUUID(), cwd: REPO, argv, cols: 110, rows: 32, env });
    const h = new Hosted(daemon, human, terminal.terminal_id, crypto.randomUUID());
    await human.request({ op: "attach", terminal_id: h.id, viewer_id: h.viewer });
    h.native = await until("SessionStart for this terminal", () => hooks().find((x) => x.event === "SessionStart" && x.terminal === h.id)?.session_id, 45000);
    return h;
  }

  info = async () => (await this.daemon.request<any>({ op: "list" })).terminals.find((t: any) => t.terminal_id === this.id);
  state = () => this.daemon.request<any>({ op: "input_state", terminal_id: this.id });

  async bound(): Promise<string> {
    return until("daemon bind", async () => (await this.info())?.target, 30000);
  }

  async ready(ms = 60000): Promise<any> {
    return until("input ready", async () => {
      const s = await this.state();
      return s.ready ? s : null;
    }, ms, 100);
  }

  submit(lead: string, text: string, epoch: number, target: string, attempt: string = crypto.randomUUID()) {
    return this.daemon.request<any>({ op: "submit", terminal_id: this.id, target, attempt_id: attempt, expected_input_epoch: epoch, lead, text });
  }

  async type(data: string): Promise<void> {
    await this.human.request({ op: "control", terminal_id: this.id, viewer_id: this.viewer, action: "acquire" });
    await this.human.request({ op: "write", terminal_id: this.id, viewer_id: this.viewer, input_id: crypto.randomUUID(), data_b64: b64.encode(new TextEncoder().encode(data)) });
    await this.human.request({ op: "control", terminal_id: this.id, viewer_id: this.viewer, action: "release" });
  }

  /** Clear a (possibly multi-line) draft the way a human would: Ctrl-U + Backspace until empty. */
  async clearDraft(): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const s = await this.state();
      if (!/draft/.test(s.reason ?? "")) return;
      await this.type("\x15\x7f");
      await Bun.sleep(50);
    }
  }

  async kill(): Promise<void> {
    await this.daemon.request({ op: "kill", terminal_id: this.id }).catch(() => {});
  }
}

export const leadFor = (batch: string) => `[foreman batch ${batch}] The human sent this from the Foreman UI; it is their instruction, act on it:`;
