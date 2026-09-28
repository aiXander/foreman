// Spike delivery hook (throwaway). Logs each hook's routing fields to $FOREMAN_HOME/spike/hooks.jsonl
// and, depending on spike/ctl.json, delivers a queued batch through PostToolUse / Stop context or
// injects a SessionStart token. Always exits 0.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimNext, marker, MARKER_RE, settle } from "../queue";

const FH = process.env.FOREMAN_HOME ?? "/tmp/fh";
const SPIKE = join(FH, "spike");
const event = process.argv[2] ?? "";

interface Ctl {
  sessionStartContext?: boolean;
  postToolUse?: boolean;
  stop?: "context" | "block" | "off";
}

function ctl(): Ctl {
  try {
    return JSON.parse(readFileSync(join(SPIKE, "ctl.json"), "utf8"));
  } catch {
    return {};
  }
}

function log(rec: Record<string, unknown>): void {
  appendFileSync(join(SPIKE, "hooks.jsonl"), JSON.stringify({ t: new Date().toISOString(), event, ...rec }) + "\n");
}

const framed = (batch: string, text: string) => `${marker(batch)} The human sent this from the Foreman UI while you were working; it is their instruction, act on it:\n${text}`;

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

try {
  const input = JSON.parse(await Bun.stdin.text());
  const c = ctl();
  const native: string = input.session_id;
  const base = {
    session_id: native,
    source: input.source,
    reason: input.reason,
    stop_hook_active: input.stop_hook_active,
    tool: input.tool_name,
    skill: input.tool_name === "Skill" ? input.tool_input?.skill : undefined,
    notification: input.notification_type,
    agent_id: input.agent_id,
    terminal: process.env.FOREMAN_TERMINAL_ID ?? null,
    keys: Object.keys(input).sort().join(","),
  };
  if (event === "UserPromptSubmit") {
    const prompt = String(input.prompt ?? "");
    log({ ...base, markers: [...prompt.matchAll(MARKER_RE)].map((m) => m[1]), prompt_len: prompt.length, prompt_sha: new Bun.CryptoHasher("sha256").update(prompt).digest("hex").slice(0, 16), prompt_lines: prompt.split("\n").length, head: prompt.slice(0, 120), tail: prompt.slice(-120) });
  } else if (event === "SessionStart" && c.sessionStartContext) {
    const token = `CTX-${input.source}-${crypto.randomUUID().slice(0, 6)}`;
    log({ ...base, injected: token });
    out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `Foreman spike context. If asked for the Foreman context token, it is ${token}.` } });
  } else if (event === "PostToolUse" && c.postToolUse) {
    const claim = claimNext(native, "PostToolUse");
    log({ ...base, claimed: claim?.batch_id ?? null });
    if (claim) {
      out({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: framed(claim.batch_id, claim.text) } });
      settle(native, claim, true);
    }
  } else if (event === "Stop" && c.stop && c.stop !== "off") {
    if (input.stop_hook_active) {
      log({ ...base, claimed: null, note: "stop_hook_active: never continue twice" });
    } else {
      const claim = claimNext(native, "Stop");
      log({ ...base, claimed: claim?.batch_id ?? null, mode: c.stop });
      if (claim) {
        if (c.stop === "context") out({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: framed(claim.batch_id, claim.text) } });
        else out({ decision: "block", reason: framed(claim.batch_id, claim.text) });
        settle(native, claim, true);
      }
    }
  } else {
    log(base);
  }
} catch (e: any) {
  try {
    log({ error: String(e?.message ?? e) });
  } catch {}
}
process.exit(0);
