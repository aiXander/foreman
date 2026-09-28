// Gate 7 — can a PreToolUse hook own the Foreman target? A throwaway plugin (generated under
// /tmp/fh/gate7) has a no-SDK MCP server whose `echo` tool does NOT advertise `target`, and a
// PreToolUse hook that stamps `target` from the hook's own session_id via `updatedInput` (plus
// `permissionDecision: allow`, no --allowedTools), and denies calls that carry an agent_id.
// Checks: (1) the main agent's call reaches the server with the stamped target and no permission
// prompt; (2) a subagent's call is denied by the hook and never reaches the server.
// Usage: bun scripts/spike/gate7-target-stamp.ts   (2 haiku `-p` turns)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE, cleanEnv, gate, log, REPO } from "./harness";

const DIR = "/tmp/fh/gate7";
const PLUGIN = join(DIR, "plugin");
const TOOL = "mcp__plugin_spk_spk__echo";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(PLUGIN, ".claude-plugin"), { recursive: true });
mkdirSync(join(PLUGIN, "hooks"), { recursive: true });

writeFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), JSON.stringify({ name: "spk", version: "0.0.0" }));
writeFileSync(join(PLUGIN, ".mcp.json"), JSON.stringify({ mcpServers: { spk: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/mcp.ts"] } } }));
writeFileSync(
  join(PLUGIN, "hooks/hooks.json"),
  JSON.stringify({ hooks: { PreToolUse: [{ matcher: "mcp__plugin_spk_spk__.*", hooks: [{ type: "command", command: 'bun "${CLAUDE_PLUGIN_ROOT}/hook.ts"', timeout: 5 }] }] } }),
);
writeFileSync(
  join(PLUGIN, "hook.ts"),
  `import { appendFileSync } from "node:fs";
const input = JSON.parse(await Bun.stdin.text());
appendFileSync("${DIR}/hook.jsonl", JSON.stringify({ tool: input.tool_name, session: input.session_id, agent_id: input.agent_id ?? null, tool_input: input.tool_input }) + "\\n");
const out = input.agent_id != null
  ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Foreman tools are for the main agent only." }
  : { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, target: "stamped:" + input.session_id } };
process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
`,
);
writeFileSync(
  join(PLUGIN, "mcp.ts"),
  `import { appendFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "spk", version: "0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Spike: echoes its arguments.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }] } });
    else if (m.method === "tools/call") {
      appendFileSync("${DIR}/mcp.jsonl", JSON.stringify(m.params?.arguments ?? null) + "\\n");
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ECHO " + JSON.stringify(m.params?.arguments) }] } });
    } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
  }
}
`,
);

const lines = (f: string) => (existsSync(join(DIR, f)) ? readFileSync(join(DIR, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function run(prompt: string): Promise<{ session: string; out: string }> {
  const p = Bun.spawn([CLAUDE, "-p", "--model", "haiku", "--plugin-dir", PLUGIN, "--output-format", "json", prompt], { cwd: REPO, env: cleanEnv, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  let r: any = {};
  try {
    r = JSON.parse(out);
  } catch {}
  log(`result: ${String(r.result ?? out).slice(0, 300).replace(/\s+/g, " ")}`);
  return { session: r.session_id ?? "", out: r.result ?? out };
}

const { check, done } = gate();

const main = await run(`Load the tool with ToolSearch query "select:${TOOL}", then call it with note "main". Reply with only the tool's output.`);
const mainCall = lines("mcp.jsonl").find((a) => a?.note === "main");
check("main agent: target stamped by the hook reaches the server", mainCall?.target === `stamped:${main.session}`, JSON.stringify(mainCall));
const mainHook = lines("hook.jsonl").find((h) => h.tool_input?.note === "main");
check("main agent: hook saw no agent_id, model sent no target", !!mainHook && mainHook.agent_id === null && mainHook.tool_input?.target === undefined, JSON.stringify(mainHook));

await run(
  `Use the Agent tool (subagent_type general-purpose) and tell the subagent: 'Load the tool with ToolSearch query "select:${TOOL}", then call it with note "sub", and report exactly what it returned or the error.' Then reply with the subagent's report.`,
);
const subHook = lines("hook.jsonl").find((h) => h.tool_input?.note === "sub");
check("subagent: hook fired with an agent_id", !!subHook?.agent_id, JSON.stringify(subHook));
check("subagent: denied call never reached the server", !lines("mcp.jsonl").some((a) => a?.note === "sub"), JSON.stringify(lines("mcp.jsonl")));
done();
