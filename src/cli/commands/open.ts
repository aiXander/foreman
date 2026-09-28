import { readFileSync } from "node:fs";
import { readServiceRecord } from "../../shared/config";
import { paths } from "../../shared/paths";
import { ensurePtyd } from "../services";
import { ensureDaemon } from "./up";

/** Mint a one-use launch link with the CLI bearer secret and open it; the daemon swaps it for a cookie. */
export async function main(args: string[]): Promise<number> {
  await ensurePtyd();
  await ensureDaemon();
  const rec = readServiceRecord(paths.daemonInfo());
  if (!rec || rec.live !== "alive") throw new Error("foremand is not running");
  const secret = readFileSync(paths.uiToken(), "utf8").trim();
  const res = await fetch(`${rec.record.endpoint}/api/v1/auth/launch-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`launch token request failed: ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  if (args.includes("--print")) {
    console.log(url);
    return 0;
  }
  Bun.spawnSync(["open", url]);
  console.log(`opened ${rec.record.endpoint} (sign-in link is single-use and expires in 60 s)`);
  return 0;
}
