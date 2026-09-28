// `foreman call <tool> '<json>'`: the CLI mirror of the MCP tools (plan §8.1). Same schemas and
// handlers; the CLI supplies request_id itself. Run by the human, so the sidecar's
// terminal-ownership check is skipped — the target alone selects the session.
import { TOOLS, toolSpec } from "../../shared/protocol";
import { callTool } from "../../shared/tools";

export async function main(args: string[]): Promise<number> {
  const [name, json] = args;
  const spec = name ? toolSpec(name) : null;
  if (!spec || args.length > 2) {
    console.error(`usage: foreman call <tool> '<json arguments>'\ntools: ${TOOLS.map((t) => t.name).join(", ")}`);
    return 2;
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(json ?? "{}");
  } catch (e) {
    console.error(`arguments must be a JSON object: ${(e as Error).message}`);
    return 2;
  }
  const needsId = spec.mutation || (name === "foreman_inbox" && Array.isArray(input.ack) && input.ack.length > 0);
  if (needsId && input.request_id === undefined) input.request_id = crypto.randomUUID();
  const r = callTool(spec.name, input, { source: "cli" });
  console.log(JSON.stringify(r, null, 2));
  return r.ok ? 0 : 1;
}
