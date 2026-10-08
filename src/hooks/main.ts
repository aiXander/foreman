// Claude Code hook entrypoint: `hook.js <EventName>` with the hook JSON on stdin.
// Contract: ALWAYS exit 0 and never block Claude. The only model-visible output is deliberate
// protocol context: SessionStart's Foreman contract and human batch delivery (PostToolUse,
// PostToolUseFailure, Stop — claimed in the journal before it is printed). PreToolUse on a
// Foreman tool also stamps the caller's target onto the call (stamp.ts). SessionStart/
// SessionEnd maintain identity; every other event is passive telemetry that is dropped (and
// logged) rather than waited on. Only names, paths and counts are stored — a prompt is read for
// batch markers and never kept.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildContract } from "../shared/contract";
import { batchMarkers, claimNext, hookContext, onUserPrompt, settle } from "../shared/delivery";
import { ActivityHook, type Payload } from "../shared/events";
import { ensureDir, paths } from "../shared/paths";
import { contractPeers, PEER_BUDGET_MS, readPeers } from "../shared/peers";
import { registerSessionEnd, registerSessionStart } from "../shared/registration";
import { appendSessionEvents, lookupNative, readManifest } from "../shared/store";
import { HANDLED_TOOLS } from "../shared/tools";
import { stampTarget } from "./stamp";

const MAX_STDIN = 1024 * 1024;
const LOG_ROTATE_BYTES = 1024 * 1024;
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function log(event: string, message: string): void {
  try {
    const file = join(ensureDir(paths.logs()), "hooks.log");
    try {
      if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${event} ${message.replace(/\s+/g, " ").slice(0, 300)}\n`, { mode: 0o600 });
  } catch {}
}

async function readStdin(): Promise<any> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.length;
    if (size > MAX_STDIN) throw new Error("hook input exceeds 1 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const clip = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** The only fields ever taken from a hook input. */
export function activityPayload(hook: ActivityHook, input: any): Payload<"activity"> {
  const tool = clip(input.tool_name, 200);
  const ti = input.tool_input;
  const paths: string[] = [];
  if (tool && FILE_TOOLS.has(tool) && ti && typeof ti === "object") {
    for (const p of [ti.file_path, ti.notebook_path]) {
      const c = clip(p, 4096);
      if (c && !paths.includes(c)) paths.push(c);
    }
  }
  let detail: string | null = null;
  if (hook === "StopFailure") detail = clip(input.error, 200);
  else if (hook === "SubagentStart" || hook === "SubagentStop") detail = clip(input.agent_type, 200);
  return {
    hook,
    tool,
    paths: paths.slice(0, 8),
    notification: hook === "Notification" ? clip(input.notification_type, 64) : null,
    detail,
    agent_id: clip(input.agent_id, 128),
  };
}

/** Record the activity event; returns the enrolled session (null: not ours to attribute). */
function passive(event: ActivityHook, input: any): string | null {
  if (typeof input?.session_id !== "string") return null;
  const session = lookupNative("claude", input.session_id.trim());
  if (!session) return null; // not enrolled (e.g. plugin loaded mid-run): nothing to attribute to
  const run = readManifest(session)?.run ?? null;
  if (!run) return null;
  try {
    appendSessionEvents(session, run, "hook", [{ type: "activity", payload: activityPayload(event, input) }], { passive: true });
  } catch (e: any) {
    log(event, `dropped: ${e?.code ?? ""} ${e?.message ?? e}`); // telemetry loss must not stop delivery
  }
  return session;
}

const DELIVERY_ROUTE = { PostToolUse: "post_tool_use", PostToolUseFailure: "post_tool_use", Stop: "stop" } as const;

/**
 * Hand the head batch to the running turn (§9.2): claim (fsynced) → print → settle. Never inside a
 * subagent (it must not receive its parent's batches), never a second Stop continuation, and
 * nothing at all when the queue is empty or held.
 */
async function deliver(event: keyof typeof DELIVERY_ROUTE, input: any, session: string): Promise<void> {
  if (input.agent_id != null) return;
  if (event === "Stop" && input.stop_hook_active !== false) return;
  const route = DELIVERY_ROUTE[event];
  const claim = claimNext(session, route);
  if (!claim) return;
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: hookContext(claim, route) } }) + "\n";
  try {
    await Bun.write(Bun.stdout, out);
  } catch (e: any) {
    // Part of it may have reached Claude: that is uncertain, not failed.
    settle(claim, "uncertain", `hook output failed: ${e?.message ?? e}`);
    return;
  }
  settle(claim, "transport_sent");
}

/** Passive telemetry, then the event's delivery duty (a batch for the turn, or prompt markers). */
async function activity(event: string, input: any): Promise<void> {
  const hook = ActivityHook.safeParse(event);
  const session = hook.success ? passive(hook.data, input) : null;
  if (!session) return;
  if (event in DELIVERY_ROUTE) await deliver(event as keyof typeof DELIVERY_ROUTE, input, session);
  else if (event === "UserPromptSubmit" && input.agent_id == null) onUserPrompt(session, batchMarkers(String(input.prompt ?? "")));
}

/** The contract's peers block (§10): best effort within its budget; a failure only omits it. */
function startPeers(session: string, input: any): string | null {
  try {
    const project = readManifest(session)?.project;
    if (!project) return null;
    return contractPeers(readPeers({ session, native_id: String(input.session_id).trim(), project }, PEER_BUDGET_MS.hook));
  } catch (e: any) {
    log("SessionStart", `peers omitted: ${e?.message ?? e}`);
    return null;
  }
}

/** Foreman tools only: print the caller's stamped target, or a refusal (stamp.ts). */
function stamp(input: any): void {
  try {
    const out = stampTarget(input);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e: any) {
    log("PreToolUse", `stamp failed: ${e?.message ?? e}`); // no target → the sidecar refuses the call
  }
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? "";
  let input: any;
  try {
    input = await readStdin();
  } catch (e: any) {
    log(event, `bad input: ${e?.message ?? e}`);
    return;
  }
  if (process.env.FOREMAN_HOOK_DEBUG === "1" && input && typeof input === "object") {
    // Diagnostic: field NAMES plus enum-valued fields only — never content.
    const enums = ["source", "reason", "notification_type", "error", "agent_type"].filter((k) => typeof input[k] === "string").map((k) => `${k}=${input[k]}`);
    log(event, `keys=${Object.keys(input).sort().join(",")} ${enums.join(" ")}`);
  }
  if (event === "SessionStart") {
    try {
      const reg = registerSessionStart(input);
      // The one deliberate behaviour change: the protocol contract (§6.3); no target — stamp.ts adds it per call.
      const additionalContext = buildContract({ target: reg.target, mode: reg.mode, source: reg.source, tools: [...HANDLED_TOOLS], peers: startPeers(reg.session, input), pagesDir: paths.sessionPages(reg.session) });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }) + "\n");
    } catch (e: any) {
      log(event, `registration failed: ${e?.code ?? ""} ${e?.message ?? e}`);
      // systemMessage is shown to the user, not the model; Claude stays fully usable.
      process.stdout.write(JSON.stringify({ systemMessage: `Foreman unavailable: ${String(e?.message ?? e).slice(0, 120)}` }) + "\n");
    }
    return;
  }
  if (event === "PreToolUse") stamp(input);
  try {
    if (event === "SessionEnd") registerSessionEnd(input);
    else await activity(event, input);
  } catch (e: any) {
    log(event, `failed: ${e?.code ?? ""} ${e?.message ?? e}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {}
  process.exit(0);
}
