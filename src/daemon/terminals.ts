// The daemon's link to ptyd: one control connection that mirrors the terminal list and keeps
// each managed terminal's route (`target`) in sync with its session's current run, plus the
// managed-Claude launcher. ptyd may be down; the daemon keeps running and reconnects.
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { LaunchOptions, LaunchRequest } from "../shared/api";
import { loadConfig, managedClaudeArgv, resolveClaude } from "../shared/config";
import { PtyClient, PtyError } from "../shared/ptyclient";
import type { InputState, InterruptResult, SubmitResult, TerminalInfo } from "../shared/ptyproto";
import type { JournalState } from "../shared/reducer";

const RECONNECT_MS = 2000;

export class PtydLink {
  terminals = new Map<string, TerminalInfo>();
  private conn: PtyClient | null = null;
  private listeners = new Set<(t: TerminalInfo | null) => void>();
  private stopped = false;
  private binding = new Set<string>();

  get up(): boolean {
    return this.conn !== null;
  }

  onChange(cb: (t: TerminalInfo | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(t: TerminalInfo | null): void {
    for (const cb of this.listeners) cb(t);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const c = await PtyClient.connect({ client: "daemon" });
      c.onPush((p) => {
        if (p.event === "terminal") {
          this.terminals.set(p.terminal.terminal_id, p.terminal);
          this.emit(p.terminal);
        }
      });
      c.onClose(() => {
        if (this.conn !== c) return;
        this.conn = null;
        this.emit(null);
        setTimeout(() => this.connect(), RECONNECT_MS);
      });
      const { terminals } = await c.request<{ terminals: TerminalInfo[] }>({ op: "list" });
      this.conn = c;
      this.terminals = new Map(terminals.map((t) => [t.terminal_id, t]));
      this.emit(null);
    } catch {
      setTimeout(() => this.connect(), RECONNECT_MS);
    }
  }

  /**
   * Route each live managed terminal to the run its SessionStart hook registered. When a terminal
   * was rebound (in-TUI /clear or /resume), the retired session is dead, so only one live claim wins.
   */
  async syncBindings(states: JournalState[]): Promise<void> {
    const c = this.conn;
    if (!c) return;
    const claims = new Map<string, JournalState>();
    for (const s of states) {
      if (s.mode !== "managed" || !s.terminal_id || !s.target || s.state === "dead") continue;
      const prev = claims.get(s.terminal_id);
      if (!prev || (s.last_event_at ?? "") > (prev.last_event_at ?? "")) claims.set(s.terminal_id, s);
    }
    for (const [tid, s] of claims) {
      const t = this.terminals.get(tid);
      if (!t || t.state !== "live" || t.target === s.target || this.binding.has(tid)) continue;
      this.binding.add(tid);
      try {
        await c.request({ op: "bind", terminal_id: tid, target: s.target, expected_target: t.target });
      } catch (e) {
        if (!(e instanceof PtyError && e.code === "CONFLICT")) console.error(`bind ${tid}: ${(e as Error).message}`);
      } finally {
        this.binding.delete(tid);
      }
    }
  }

  /** ptyd's own reading of a terminal's input box (daemon-only op). */
  inputState(terminalId: string): Promise<InputState> {
    return this.need().request<InputState>({ op: "input_state", terminal_id: terminalId });
  }

  /** Idle delivery: ptyd re-checks readiness, types lead + text, presses Enter (daemon-only op). */
  submit(req: { terminal_id: string; target: string; attempt_id: string; expected_input_epoch: number; lead: string; text: string }): Promise<SubmitResult> {
    return this.need().request<SubmitResult>({ op: "submit", ...req });
  }

  /** Stop: ptyd writes one ESC only while the terminal reports busy (daemon-only op). */
  interrupt(req: { terminal_id: string; target: string; interrupt_id: string }): Promise<InterruptResult> {
    return this.need().request<InterruptResult>({ op: "interrupt", ...req });
  }

  /** Signal a managed terminal's process (SIGTERM: Claude exits as if the terminal closed). */
  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  kill(terminalId: string): Promise<{ signaled: boolean }> {
    return this.need().request<{ signaled: boolean }>({ op: "kill", terminal_id: terminalId, signal: "SIGTERM" });
  }

  private need(): PtyClient {
    if (!this.conn) throw new PtyError("RESYNC_REQUIRED", "terminal host (ptyd) is not connected");
    return this.conn;
  }

  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  async launch(req: LaunchRequest, options: LaunchOptions): Promise<TerminalInfo> {
    const c = this.conn;
    if (!c) throw new HttpError(503, "terminal host (ptyd) is not running — run `foreman up`");
    if (!isAbsolute(req.cwd) || !existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) throw new HttpError(400, "cwd must be an existing absolute directory");
    if (req.model && !validModel(req.model, options)) throw new HttpError(400, `unknown model: ${req.model}`);
    if (req.effort && !options.efforts.includes(req.effort)) throw new HttpError(400, `unknown effort: ${req.effort}`);
    if (req.prompt !== undefined && req.prompt.length > 8000) throw new HttpError(400, "prompt too long");
    const argv = managedClaudeArgv([]);
    if (req.model) argv.push("--model", req.model);
    if (req.effort) argv.push("--effort", req.effort);
    if (req.prompt?.trim()) argv.push("--", req.prompt);
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    const { terminal } = await c.request<{ terminal: TerminalInfo }>({
      op: "create",
      request_id: req.request_id,
      cwd: req.cwd,
      argv,
      cols: 120,
      rows: 36,
      env,
    });
    this.terminals.set(terminal.terminal_id, terminal);
    this.emit(terminal);
    return terminal;
  }
}

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

function validModel(m: string, o: LaunchOptions): boolean {
  return o.models.includes(m) || /^claude-[a-z0-9.-]{1,80}$/.test(m);
}

const KNOWN_ALIASES = ["fable", "opus", "sonnet", "haiku"];
let cachedOptions: LaunchOptions | null = null;

/** Model aliases and effort levels as advertised by the installed Claude CLI's --help. */
export function launchOptions(): LaunchOptions {
  if (cachedOptions) return cachedOptions;
  let help = "";
  let version: string | null = null;
  try {
    const claude = resolveClaude(loadConfig());
    help = Bun.spawnSync([claude, "--help"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    version = Bun.spawnSync([claude, "--version"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim() || null;
  } catch {}
  const flat = help.replace(/\s+/g, " ");
  const modelDesc = flat.match(/--model <model>(.*?)(?= --?[a-z])/)?.[1] ?? "";
  // --help only quotes *examples* of aliases, so merge them with the known alias set.
  const quoted = [...modelDesc.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!).filter((m) => !m.startsWith("claude-"));
  const models = [...new Set([...quoted, ...KNOWN_ALIASES])];
  const effortDesc = flat.match(/--effort <level>[^(]*\(([^)]*)\)/)?.[1] ?? "";
  const efforts = effortDesc.split(",").map((e) => e.trim()).filter((e) => /^[a-z]+$/.test(e));
  cachedOptions = { models, efforts, claude_version: version };
  return cachedOptions;
}
