// ~/.foreman/config.json and the run/<service>.json service records.
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ensureHome, paths } from "./paths";
import { qualifiedTool, TOOLS } from "./protocol";
import { liveness, selfStart, type Liveness } from "./proc";
import { readJson, writeJsonAtomic } from "./store";

export interface Config {
  version: 1;
  bind: "127.0.0.1";
  port: number;
  /**
   * The page listener (pages: reads, and a page's saves to its declared files). It serves `http://localhost:<page_port>`: a different host
   * name from the daemon's 127.0.0.1, because cookies ignore ports. Default: port + 1.
   */
  page_port: number;
  /** Extra browser origins allowed besides the daemon's own (e.g. the Vite dev server). */
  extra_origins: string[];
  /** Absolute path to the real Claude executable; null = resolve from PATH, skipping wrappers. */
  claude_executable: string | null;
}

const DEFAULT_PORT = 7717;

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(paths.config()) ?? {};
  const port = Number.isInteger(raw.port) ? raw.port! : Number(process.env.FOREMAN_PORT) || DEFAULT_PORT;
  return {
    version: 1,
    bind: "127.0.0.1",
    port,
    page_port: Number.isInteger(raw.page_port) ? raw.page_port! : Number(process.env.FOREMAN_PAGE_PORT) || port + 1,
    extra_origins: Array.isArray(raw.extra_origins) ? raw.extra_origins : [],
    claude_executable: typeof raw.claude_executable === "string" ? raw.claude_executable : null,
  };
}


/**
 * The real Claude binary. PATH wrappers (c11's session-resume shim lives in an app bundle's
 * Resources/bin) are skipped: ptyd-owned sessions must not bind to a launcher's surface identity.
 */
export function resolveClaude(config: Config = loadConfig()): string {
  if (config.claude_executable) return config.claude_executable;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir.includes(".app/Contents/")) continue;
    const p = join(dir, "claude");
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  for (const p of [join(process.env.HOME ?? "", ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("claude executable not found; set claude_executable in ~/.foreman/config.json");
}

export interface ServiceRecord {
  pid: number;
  start: string;
  protocol: number;
  endpoint: string;
  started_at: string;
  version: string;
}

export function writeServiceRecord(file: string, endpoint: string, protocol: number): void {
  ensureHome();
  writeJsonAtomic(file, {
    pid: process.pid,
    start: selfStart(),
    protocol,
    endpoint,
    started_at: new Date().toISOString(),
    version: "0.1.0",
  } satisfies ServiceRecord);
}

export function readServiceRecord(file: string): { record: ServiceRecord; live: Liveness } | null {
  const record = readJson<ServiceRecord>(file);
  if (!record) return null;
  return { record, live: liveness(record.pid, record.start) };
}

export const pluginDir = () => join(import.meta.dir, "..", "..", "plugin");

/** True when a user-scoped `foreman` plugin install exists (then managed launches skip --plugin-dir). */
function pluginInstalledForUser(): boolean {
  const f = join(process.env.HOME ?? "", ".claude", "plugins", "installed_plugins.json");
  const data = readJson<any>(f);
  if (!data) return false;
  const keys = Object.keys(data.plugins ?? data ?? {});
  return keys.some((k) => k === "foreman" || k.startsWith("foreman@"));
}

/**
 * argv for a managed Claude: the real binary, the plugin (unless a user-scoped install already
 * provides it — never load it twice) and permission for the Foreman MCP tools, which otherwise
 * prompt (phase 0). `--allowedTools` is variadic, so the `=` form keeps it from swallowing a
 * following positional prompt.
 */
export function managedClaudeArgv(args: string[]): string[] {
  const plugin = pluginDir();
  const withPlugin = !pluginInstalledForUser() && existsSync(join(plugin, ".claude-plugin"));
  const allow = TOOLS.map((t) => qualifiedTool(t.name)).join(",");
  return [resolveClaude(), ...(withPlugin ? ["--plugin-dir", plugin] : []), `--allowedTools=${allow}`, ...args];
}
