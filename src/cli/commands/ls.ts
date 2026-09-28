// `foreman ls`: list ptyd terminals.
import { PtyClient } from "../../shared/ptyclient";
import type { TerminalInfo } from "../../shared/ptyproto";

export async function main(_args: string[]): Promise<number> {
  let client: PtyClient;
  try {
    client = await PtyClient.connect({ client: "cli" });
  } catch {
    console.log("ptyd is not running (start it with `foreman up` or `foreman run claude`).");
    return 1;
  }
  const { terminals } = await client.request<{ terminals: TerminalInfo[] }>({ op: "list" });
  client.close();
  if (!terminals.length) {
    console.log("no terminals");
    return 0;
  }
  const home = process.env.HOME ?? "";
  const rows = terminals.map((t) => [
    t.terminal_id,
    t.state === "live" ? "live" : `exited(${t.exit?.signal ?? t.exit?.code ?? "?"})`,
    String(t.pid),
    `${t.cols}x${t.rows}`,
    t.viewers + (t.writer ? "*" : ""),
    t.target ? t.target.slice(0, 8) : "-",
    home && t.cwd.startsWith(home) ? "~" + t.cwd.slice(home.length) : t.cwd,
  ]);
  const head = ["TERMINAL", "STATE", "PID", "SIZE", "VIEWERS", "TARGET", "CWD"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const r of [head, ...rows]) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  "));
  return 0;
}
