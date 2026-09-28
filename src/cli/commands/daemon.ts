import { runDaemon } from "../../daemon/main";

export async function main(_args: string[]): Promise<number> {
  await runDaemon();
  await new Promise(() => {}); // serve until signalled
  return 0;
}
