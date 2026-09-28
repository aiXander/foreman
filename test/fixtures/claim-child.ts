// Claim-race child (no model): keeps claiming + settling the shared session's queue until it has
// found nothing for a while, as concurrent hooks and the daemon worker would.
import { claimNext, settle } from "../../src/shared/delivery";

const [session, route] = process.argv.slice(2) as [string, "post_tool_use" | "stop" | "idle_submit"];
for (let idle = 0; idle < 150; ) {
  let c = null;
  try {
    c = claimNext(session, route, { lockTimeoutMs: 2000 });
  } catch {}
  if (!c) {
    idle++;
    await Bun.sleep(2);
    continue;
  }
  idle = 0;
  settle(c, "transport_sent");
}
