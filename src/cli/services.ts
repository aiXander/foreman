// Starting background services (ptyd, daemon) from the CLI.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { readServiceRecord } from "../shared/config";
import { ensureHome, paths } from "../shared/paths";
import { PtyClient } from "../shared/ptyclient";

const MAIN = join(import.meta.dir, "main.ts");

/** Spawn `bun src/cli/main.ts <command>` detached, logging to logs/<logFile>, and wait ≤5 s for its record. */
export async function startDetached(command: "ptyd" | "daemon", logFile: string): Promise<void> {
  ensureHome();
  const out = openSync(join(paths.logs(), logFile), "a", 0o600);
  const child = spawn(process.execPath, [MAIN, command], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  const record = command === "ptyd" ? paths.ptydInfo() : paths.daemonInfo();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = readServiceRecord(record);
    if (r && r.record.pid === child.pid && r.live !== "dead") return;
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error(`${command} did not start; see ${join(paths.logs(), logFile)}`);
}

async function ptydAnswers(): Promise<boolean> {
  try {
    (await PtyClient.connect({ client: "cli" })).close();
    return true;
  } catch {
    return false;
  }
}

/** Make sure a ptyd answers on the socket, starting one in the background if needed. */
export async function ensurePtyd(): Promise<void> {
  if (await ptydAnswers()) return;
  await startDetached("ptyd", "ptyd.log");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await ptydAnswers()) return;
    await Bun.sleep(50);
  }
  throw new Error("ptyd started but its socket does not answer");
}
