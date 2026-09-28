// `foreman run claude [args]`: start a managed Claude terminal in ptyd and attach to it.
import { managedClaudeArgv } from "../../shared/config";
import { PtyClient } from "../../shared/ptyclient";
import type { TerminalInfo } from "../../shared/ptyproto";
import { ensurePtyd } from "../services";
import { attachTerminal } from "./attach";

export async function main(args: string[]): Promise<number> {
  if (args[0] !== "claude") {
    console.error("usage: foreman run claude [claude args...]");
    return 2;
  }
  await ensurePtyd();
  const client = await PtyClient.connect({ client: "cli" });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  try {
    const { terminal } = await client.request<{ terminal: TerminalInfo }>({
      op: "create",
      request_id: crypto.randomUUID(),
      cwd: process.cwd(),
      argv: managedClaudeArgv(args.slice(1)),
      cols: clamp(process.stdout.columns || 100, 20, 500),
      rows: clamp(process.stdout.rows || 30, 5, 200),
      env,
    });
    return await attachTerminal(client, terminal.terminal_id);
  } catch (e) {
    client.close();
    throw e;
  }
}
