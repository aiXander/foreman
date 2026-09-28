// `foreman ptyd`: run the terminal host in the foreground (the background form is `foreman up`).
import { rmSync } from "node:fs";
import { readServiceRecord } from "../../shared/config";
import { paths } from "../../shared/paths";
import { startPtyd } from "../../ptyd/server";

export async function main(_args: string[]): Promise<number> {
  const server = await startPtyd();
  console.log(`ptyd ${process.pid} listening on ${server.socketPath} (stream epoch ${server.streamEpoch})`);
  await new Promise<void>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => resolve());
  });
  // Graceful stop hangs up every child: agents die with ptyd (they stay resumable via Claude).
  server.stop();
  if (readServiceRecord(paths.ptydInfo())?.record.pid === process.pid) rmSync(paths.ptydInfo(), { force: true });
  return 0;
}
