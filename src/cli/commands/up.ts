import { readServiceRecord } from "../../shared/config";
import { paths } from "../../shared/paths";
import { ensurePtyd, startDetached } from "../services";
import { serviceStatus } from "./status";

export async function ensureDaemon(): Promise<void> {
  const s = readServiceRecord(paths.daemonInfo());
  if (s?.live === "alive") return;
  await startDetached("daemon", "foremand.log");
}

export async function main(_args: string[]): Promise<number> {
  await ensurePtyd();
  await ensureDaemon();
  console.log(`ptyd     ${serviceStatus(paths.ptydInfo())}`);
  console.log(`foremand ${serviceStatus(paths.daemonInfo())}`);
  return 0;
}
