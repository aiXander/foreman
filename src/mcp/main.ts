// Foreman's stdio MCP sidecar (bundled to plugin/dist/mcp.js). Claude Code starts one per session
// process; it survives /clear and inherits FOREMAN_TERMINAL_ID, so it never knows "the current
// conversation" by itself — every tool takes an explicit `target` (§6.2) and callTool validates it.
// stdout is the JSON-RPC wire: diagnostics go to stderr only.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { TOOLS, type ToolResult } from "../shared/protocol";
import { callTool, HANDLED_TOOLS, type ToolContext } from "../shared/tools";

const VERSION = "0.2.0";

const INSTRUCTIONS =
  "Foreman is the human's local supervision dashboard for this session. Follow the Foreman contract given at session start: " +
  "it holds your `target` (pass it on every call) and the rules for briefs, progress, questions (foreman_ask, never AskUserQuestion), " +
  "human batches and the handover. Load the skill foreman:foreman for the full protocol.";

/**
 * Advertise the Zod schema as JSON Schema but let every input through to callTool, which
 * validates with the same schema and answers in the protocol's own error envelope
 * ({ok:false, code:"VALIDATION", field, message}) — identical to the CLI and HTTP surfaces.
 */
function advertiseOnly(schema: z.ZodType) {
  const emit = (io: "input" | "output") => (o: { target: string }) => {
    const { $schema: _, ...json } = z.toJSONSchema(schema, { target: o.target as "draft-2020-12", io }) as Record<string, unknown>;
    return json;
  };
  return {
    "~standard": {
      version: 1 as const,
      vendor: "foreman",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: emit("input"), output: emit("output") },
    },
  };
}

function toMcp(r: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(r) }], structuredContent: r as Record<string, unknown>, isError: !r.ok };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "foreman", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const terminal = process.env.FOREMAN_TERMINAL_ID?.trim() || null;
  const ctx: ToolContext = { source: "mcp", envTerminal: terminal };
  for (const t of TOOLS) {
    if (!HANDLED_TOOLS.has(t.name)) continue;
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: advertiseOnly(t.input) as any,
        annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: unknown) => toMcp(callTool(t.name, args, ctx)),
    );
  }
  return server;
}

const handle = serveStdio(() => buildServer(), { onerror: (e: Error) => console.error(`[foreman-mcp] ${e.message}`) });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void handle.close().finally(() => process.exit(0)));
}
