import { readServiceRecord } from "../../shared/config";
import { paths } from "../../shared/paths";

export function serviceStatus(file: string): string {
  const s = readServiceRecord(file);
  if (!s) return "not running";
  if (s.live === "dead") return `not running (stale record, pid ${s.record.pid})`;
  return `${s.live === "alive" ? "running" : "unknown"} · pid ${s.record.pid} · ${s.record.endpoint} · since ${s.record.started_at}`;
}

export async function main(_args: string[]): Promise<number> {
  console.log(`ptyd     ${serviceStatus(paths.ptydInfo())}`);
  console.log(`foremand ${serviceStatus(paths.daemonInfo())}`);
  console.log(`home     ${paths.home()}`);
  return 0;
}
