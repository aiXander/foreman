// Spike stdio MCP server (throwaway, no SDK): one `ping` tool, to learn the tool namespace a
// plugin-bundled server gets and what identity the sidecar inherits from Claude's environment.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const SPIKE = join(process.env.FOREMAN_HOME ?? "/tmp/fh", "spike");
const log = (rec: unknown) => appendFileSync(join(SPIKE, "mcp.jsonl"), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...(rec as object) }) + "\n");
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

log({ started: true, terminal: process.env.FOREMAN_TERMINAL_ID ?? null, ppid: process.ppid });

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "foreman-spike", version: "0.0.0" } } });
    } else if (m.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: { tools: [{ name: "ping", description: "Foreman spike: returns the sidecar's inherited identity.", inputSchema: { type: "object", properties: { target: { type: "string" } }, additionalProperties: false } }] },
      });
    } else if (m.method === "tools/call") {
      const r = { terminal: process.env.FOREMAN_TERMINAL_ID ?? null, target_arg: m.params?.arguments?.target ?? null };
      log({ call: m.params?.name, ...r });
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `PING-OK ${JSON.stringify(r)}` }] } });
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
    }
  }
}
