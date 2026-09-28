// `foreman attach` driven through a real PTY: input reaches the child, Ctrl-] d detaches
// without sending anything to it, and the child keeps running.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PtyClient } from "../src/shared/ptyclient";
import type { TerminalInfo } from "../src/shared/ptyproto";
import { startPtyd, type PtydServer } from "../src/ptyd/server";

let dir: string;
let server: PtydServer;

beforeAll(async () => {
  dir = mkdtempSync("/tmp/fm-cli-");
  process.env.FOREMAN_HOME = dir;
  server = await startPtyd({ writeRecord: false });
});
afterAll(() => {
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("attach forwards input, detaches on Ctrl-] d and leaves the child alive", async () => {
  const c = await PtyClient.connect({ client: "cli" });
  const { terminal } = await c.request<{ terminal: TerminalInfo }>({
    op: "create", request_id: crypto.randomUUID(), cwd: dir, argv: ["/bin/cat"], cols: 80, rows: 24,
  });
  let out = "";
  const cli = Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), "attach", terminal.terminal_id.slice(0, 8)], {
    env: { ...process.env, FOREMAN_HOME: dir },
    terminal: { cols: 80, rows: 24, data: (_t, d) => (out += new TextDecoder().decode(d)) },
  });
  const until = async (s: string) => {
    for (let i = 0; i < 250 && !out.includes(s); i++) await Bun.sleep(20);
    expect(out).toContain(s);
  };
  const writer = async () => ((await c.request<{ terminals: TerminalInfo[] }>({ op: "list" })).terminals[0]!.writer);
  for (let i = 0; i < 250 && !(await writer()); i++) await Bun.sleep(20);
  await Bun.sleep(150); // past the snapshot's reply-suppression window
  cli.terminal!.write("hello-from-cli\r");
  await until("hello-from-cli");
  cli.terminal!.write("\x1dd");
  expect(await cli.exited).toBe(0);
  expect(out).toContain("detached from");
  const t = (await c.request<{ terminals: TerminalInfo[] }>({ op: "list" })).terminals[0]!;
  expect(t.state).toBe("live");
  expect(t.writer).toBeNull();
  c.close();
}, 15000);
