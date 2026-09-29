// The stdio MCP sidecar as Claude Code runs it: JSON-RPC over stdin/stdout, identity from the
// inherited FOREMAN_TERMINAL_ID, protocol errors as isError results the model can read.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { registerSessionStart } from "../src/shared/registration";
import { useTempHome } from "./fixtures/home";

const tmp = useTempHome();

async function rpc(env: Record<string, string>, calls: { method: string; params?: unknown }[]): Promise<any[]> {
  const msgs = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c })),
  ];
  // Keep stdin open until every call is answered: the server exits as soon as stdin closes.
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/mcp/main.ts")], { env: { ...process.env, FOREMAN_HOME: tmp.home(), ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const m of msgs) p.stdin.write(JSON.stringify(m) + "\n");
  p.stdin.flush();
  const byId = new Map<number, any>();
  const reader = p.stdout.getReader();
  let buf = "";
  while (byId.size < calls.length + 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.id !== undefined) byId.set(m.id, m);
    }
  }
  p.stdin.end();
  await p.exited;
  return calls.map((_, i) => byId.get(i + 1));
}

test("sidecar lists object-typed tool schemas and acts only for its own terminal's target", async () => {
  const term = crypto.randomUUID();
  const reg = registerSessionStart({ session_id: "mcp1", cwd: tmp.cwd(), source: "startup" }, { FOREMAN_TERMINAL_ID: term });
  const brief = (target: string) => ({ method: "tools/call", params: { name: "foreman_brief", arguments: { target, request_id: crypto.randomUUID(), goal: "g", done_when: "d" } } });

  const [list, ok, bad] = await rpc({ FOREMAN_TERMINAL_ID: term }, [{ method: "tools/list" }, brief(reg.target), { method: "tools/call", params: { name: "foreman_brief", arguments: { target: reg.target } } }]);
  const tools = list.result.tools;
  expect(tools.map((t: any) => t.name)).toContain("foreman_inbox");
  for (const t of tools) {
    expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(t.inputSchema.properties.target).toBeUndefined(); // the PreToolUse hook stamps it
    expect(t.inputSchema.required ?? []).not.toContain("target");
  }
  expect(ok.result).toMatchObject({ isError: false, structuredContent: { ok: true, result: { brief: "set" } } });
  expect(bad.result).toMatchObject({ isError: true, structuredContent: { ok: false, code: "VALIDATION" } });

  const [foreign, unstamped] = await rpc({ FOREMAN_TERMINAL_ID: crypto.randomUUID() }, [brief(reg.target), { method: "tools/call", params: { name: "foreman_brief", arguments: { request_id: crypto.randomUUID(), goal: "g", done_when: "d" } } }]);
  expect(foreign.result).toMatchObject({ isError: true, structuredContent: { code: "STALE_TARGET" } });
  // No hook stamp (hook missing): fail closed, never guess the session.
  expect(unstamped.result).toMatchObject({ isError: true, structuredContent: { code: "NOT_REGISTERED", field: "target" } });
}, 20_000);
