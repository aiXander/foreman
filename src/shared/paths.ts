// Every on-disk location Foreman owns lives under one home (default ~/.foreman/).
// Tests and isolated runs point FOREMAN_HOME elsewhere; nothing writes into project repos.
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function foremanHome(): string {
  return process.env.FOREMAN_HOME || join(homedir(), ".foreman");
}

export const paths = {
  home: () => foremanHome(),
  config: () => join(foremanHome(), "config.json"),
  secrets: () => join(foremanHome(), "secrets"),
  uiToken: () => join(foremanHome(), "secrets", "ui-token"),
  run: () => join(foremanHome(), "run"),
  ptydSock: () => join(foremanHome(), "run", "ptyd.sock"),
  ptydInfo: () => join(foremanHome(), "run", "ptyd.json"),
  daemonInfo: () => join(foremanHome(), "run", "foremand.json"),
  registrationLock: () => join(foremanHome(), "run", "registration-lock"),
  sessions: () => join(foremanHome(), "sessions"),
  session: (uuid: string) => join(foremanHome(), "sessions", uuid),
  sessionJournal: (uuid: string) => join(foremanHome(), "sessions", uuid, "events.jsonl"),
  sessionManifest: (uuid: string) => join(foremanHome(), "sessions", uuid, "manifest.json"),
  sessionLock: (uuid: string) => join(foremanHome(), "sessions", uuid, ".write-lock"),
  // Throwaway pages an agent may mount without a project folder (foreman_page); served as their own root.
  sessionPages: (uuid: string) => join(foremanHome(), "sessions", uuid, "pages"),
  // Identity map: native conversation id -> Foreman session UUID. Rebuildable from journals.
  byNative: () => join(foremanHome(), "sessions", "by-native"),
  byNativeEntry: (vendor: string, nativeId: string) =>
    join(foremanHome(), "sessions", "by-native", `${vendor}-${nativeId}`),
  // Managed terminal -> {session, run} it currently routes to (hook-maintained, rebuildable).
  byTerminal: () => join(foremanHome(), "sessions", "by-terminal"),
  byTerminalEntry: (terminalId: string) => join(foremanHome(), "sessions", "by-terminal", `${terminalId}.json`),
  // Run target (the MCP routing handle) -> Foreman session UUID. Rebuildable from run.started.
  byTarget: () => join(foremanHome(), "sessions", "by-target"),
  byTargetEntry: (target: string) => join(foremanHome(), "sessions", "by-target", target),
  cache: () => join(foremanHome(), "cache"),
  projection: () => join(foremanHome(), "cache", "projection.sqlite"),
  ui: () => join(foremanHome(), "ui"),
  uiJournal: () => join(foremanHome(), "ui", "events.jsonl"),
  uiLock: () => join(foremanHome(), "ui", ".write-lock"),
  // The last few versions of each file a page replaced (P1b undo), per pin; never in the user's folder.
  pageBackups: (pinId: string) => join(foremanHome(), "ui", "page-backups", pinId),
  logs: () => join(foremanHome(), "logs"),
};

/** mkdir -p with owner-only permissions on every directory we create. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

export function ensureHome(): void {
  for (const d of [paths.home(), paths.secrets(), paths.run(), paths.sessions(), paths.byNative(), paths.cache(), paths.ui(), paths.logs()]) {
    ensureDir(d);
  }
}
