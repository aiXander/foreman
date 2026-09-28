#!/usr/bin/env bun
// `foreman` CLI dispatcher. Each command lives in its own module so it loads only what it needs.

const commands: Record<string, { summary: string; load: () => Promise<{ main: (args: string[]) => Promise<number> }> }> = {
  run: { summary: "run claude [args]   start a managed Claude terminal and attach", load: () => import("./commands/run") },
  attach: { summary: "attach <terminal-id> attach to a managed terminal (detach: Ctrl-] d)", load: () => import("./commands/attach") },
  ls: { summary: "ls                  list managed terminals", load: () => import("./commands/ls") },
  kill: { summary: "kill <terminal-id>  terminate a managed terminal's process", load: () => import("./commands/kill") },
  ptyd: { summary: "ptyd                run the terminal host in the foreground", load: () => import("./commands/ptyd") },
  daemon: { summary: "daemon              run the web daemon in the foreground", load: () => import("./commands/daemon") },
  up: { summary: "up                  start ptyd and the daemon in the background if not running", load: () => import("./commands/up") },
  down: { summary: "down [--ptyd]       stop the daemon (and ptyd with --ptyd: kills its agents)", load: () => import("./commands/down") },
  open: { summary: "open                open the web UI in the browser (signs it in)", load: () => import("./commands/open") },
  status: { summary: "status              show service status", load: () => import("./commands/status") },
  call: { summary: "call <tool> '<json>' call a Foreman protocol tool (MCP mirror) against a target", load: () => import("./commands/call") },
};

function usage(): string {
  return ["usage: foreman <command> [args]", "", ...Object.values(commands).map((c) => "  " + c.summary)].join("\n");
}

const [name, ...rest] = process.argv.slice(2);
const cmd = name ? commands[name] : undefined;
if (!cmd) {
  console.error(usage());
  process.exit(name && name !== "help" && name !== "--help" ? 2 : 0);
}
try {
  const code = await (await cmd.load()).main(rest);
  process.exit(code);
} catch (e: any) {
  console.error(`foreman ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
