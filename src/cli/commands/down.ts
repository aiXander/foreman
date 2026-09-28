import { readServiceRecord } from "../../shared/config";
import { paths } from "../../shared/paths";

async function stop(name: string, file: string): Promise<void> {
  const s = readServiceRecord(file);
  if (!s || s.live !== "alive") return console.log(`${name}: not running`);
  process.kill(s.record.pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (readServiceRecord(file)?.live !== "alive") return console.log(`${name}: stopped`);
  }
  console.log(`${name}: still running after 5 s (pid ${s.record.pid})`);
}

export async function main(args: string[]): Promise<number> {
  await stop("foremand", paths.daemonInfo());
  if (args.includes("--ptyd")) {
    // ptyd owns every managed Claude process: stopping it ends them (resumable with claude --resume).
    await stop("ptyd", paths.ptydInfo());
  } else {
    console.log("ptyd: left running (managed agents keep working); use --ptyd to stop it too");
  }
  return 0;
}
