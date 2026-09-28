// foremand: projection + API + UI. Restarting it never touches agents (they live in ptyd).
import { rmSync } from "node:fs";
import { loadConfig, readServiceRecord, writeServiceRecord } from "../shared/config";
import { ensureHome, paths } from "../shared/paths";
import { Auth, loadOrCreateSecret } from "./auth";
import { Hub } from "./hub";
import { IdleWorker } from "./idle-worker";
import { Projection } from "./projection";
import { serve } from "./server";
import { StopControl } from "./stopper";
import { Trays } from "./trays";
import { PtydLink } from "./terminals";

const DAEMON_PROTOCOL = 1;

export async function runDaemon(): Promise<void> {
  ensureHome();
  const existing = readServiceRecord(paths.daemonInfo());
  if (existing && existing.live === "alive" && existing.record.pid !== process.pid) {
    throw new Error(`foremand already running (pid ${existing.record.pid}) at ${existing.record.endpoint}`);
  }
  const config = loadConfig();
  const auth = new Auth(loadOrCreateSecret(), config);
  const projection = new Projection();
  const ptyd = new PtydLink();
  const worker = new IdleWorker(projection, ptyd);
  const trays = new Trays();
  const stops = new StopControl(ptyd, () => hub.recompute());
  const hub = new Hub(projection, ptyd, worker, trays, stops);
  projection.start();
  await ptyd.start();
  hub.start();
  worker.start();
  const server = serve({ config, auth, hub, projection, ptyd, trays, stops });
  writeServiceRecord(paths.daemonInfo(), auth.origin, DAEMON_PROTOCOL);
  console.log(`foremand listening on ${auth.origin} (ptyd ${ptyd.up ? "connected" : "not running"})`);

  const shutdown = () => {
    server.stop(true);
    worker.stop();
    stops.stopAll();
    hub.stop();
    ptyd.stop();
    projection.stop();
    const rec = readServiceRecord(paths.daemonInfo());
    if (rec?.record.pid === process.pid) rmSync(paths.daemonInfo(), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
