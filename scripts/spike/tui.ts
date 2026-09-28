// Phase-0 spike helper (throwaway): run a real Claude TUI in a Bun PTY with a headless xterm,
// record the raw stream, every OSC sequence and DEC private-mode toggle, and expose the screen.
// Used by the idle-delivery / identity probes. Never points at the real ~/.foreman.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Terminal as XTerm } from "@xterm/headless";
import { progressFromOsc } from "../../src/ptyd/readiness";
import type { Progress } from "../../src/shared/ptyproto";

export const FH = process.env.FOREMAN_HOME ?? "/tmp/fh";
if (!FH.startsWith("/tmp/")) throw new Error(`spike refuses FOREMAN_HOME=${FH}`);
export const SPIKE = join(FH, "spike");
mkdirSync(SPIKE, { recursive: true });
export const REPO = join(import.meta.dir, "..", "..");

export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_|CMUX_|C11_)/.test(k)) continue;
    env[k] = v;
  }
  env.FOREMAN_HOME = FH;
  env.TERM = "xterm-256color";
  return { ...env, ...extra };
}

export interface Mark {
  t: number;
  kind: "osc" | "mode" | "write";
  what: string;
}

export class Tui {
  xt: XTerm;
  marks: Mark[] = [];
  lastOutputAt = Date.now();
  progress: Progress = "none";
  /** Bumped by every write that is not a framed submit (mirrors ptyd input_epoch). */
  inputEpoch = 0;
  bytesOut = 0;
  proc: ReturnType<typeof Bun.spawn>;
  exited = false;
  private t0 = Date.now();

  constructor(
    argv: string[],
    readonly name: string,
    opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number } = {},
  ) {
    const cols = opts.cols ?? 110;
    const rows = opts.rows ?? 32;
    this.xt = new XTerm({ cols, rows, allowProposedApi: true, scrollback: 2000 });
    const mark = (kind: Mark["kind"], what: string) => {
      this.marks.push({ t: Date.now() - this.t0, kind, what });
      appendFileSync(join(SPIKE, `${name}.marks`), `${Date.now() - this.t0} ${kind} ${JSON.stringify(what)}\n`);
    };
    for (const id of [0, 1, 2, 7, 8, 9, 52, 133, 633, 777, 1337]) {
      this.xt.parser.registerOscHandler(id, (data) => {
        mark("osc", `${id};${data.slice(0, 160)}`);
        if (id === 9) this.progress = progressFromOsc(data) ?? this.progress;
        return false;
      });
    }
    for (const final of ["h", "l"]) {
      this.xt.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        mark("mode", `?${params.join(";")}${final}`);
        return false;
      });
    }
    // Answer terminal queries (DA etc.) like a real terminal would.
    this.xt.onData((d) => this.proc?.terminal?.write(d));
    this.proc = Bun.spawn(argv, {
      cwd: opts.cwd ?? REPO,
      env: scrubbedEnv(opts.env),
      terminal: {
        cols,
        rows,
        data: (_t, d) => {
          this.lastOutputAt = Date.now();
          this.bytesOut += d.length;
          appendFileSync(join(SPIKE, `${name}.raw`), d);
          this.xt.write(new Uint8Array(d));
        },
      },
      onExit: () => {
        this.exited = true;
      },
    });
  }

  /** Current viewport as text (after the emulator parsed everything queued so far). */
  screen(): Promise<string> {
    return new Promise((res) =>
      this.xt.write("", () => {
        const b = this.xt.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < this.xt.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
        res(lines.join("\n"));
      }),
    );
  }

  write(data: string | Uint8Array, label?: string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.marks.push({ t: Date.now() - this.t0, kind: "write", what: label ?? JSON.stringify(new TextDecoder().decode(bytes)).slice(0, 80) });
    this.proc.terminal!.write(bytes);
  }

  async waitScreen(what: string, pred: (s: string) => boolean, ms = 30000, poll = 100): Promise<string> {
    const end = Date.now() + ms;
    for (;;) {
      const s = await this.screen();
      if (pred(s)) return s;
      if (Date.now() > end) throw new Error(`[${this.name}] timed out waiting for ${what}\n--- screen ---\n${s}`);
      await Bun.sleep(poll);
    }
  }

  kill(): void {
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }
}
