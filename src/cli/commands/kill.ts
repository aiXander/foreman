// `foreman kill <terminal-id> [--signal SIGTERM|SIGHUP|SIGKILL]`: signal a managed terminal's process.
import { PtyClient } from "../../shared/ptyclient";
import { resolveTerminalId } from "./attach";

export async function main(args: string[]): Promise<number> {
  const si = args.indexOf("--signal");
  const signal = (si >= 0 ? args[si + 1] : "SIGTERM") as "SIGTERM" | "SIGHUP" | "SIGKILL";
  const ref = args.find((a, i) => !a.startsWith("--") && (si < 0 || i !== si + 1));
  if (!ref) {
    console.error("usage: foreman kill <terminal-id> [--signal SIGTERM|SIGHUP|SIGKILL]");
    return 2;
  }
  const client = await PtyClient.connect({ client: "cli" });
  try {
    const id = await resolveTerminalId(client, ref);
    const { signaled } = await client.request<{ signaled: boolean }>({ op: "kill", terminal_id: id, signal });
    console.log(signaled ? `sent ${signal} to ${id}` : `${id} has already exited`);
    return 0;
  } finally {
    client.close();
  }
}
