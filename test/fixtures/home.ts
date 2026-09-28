// Per-test isolated FOREMAN_HOME (in-process store calls read it at call time) plus a project dir.
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useTempHome(): { home: () => string; cwd: () => string } {
  let home = "";
  let cwd = "";
  const prev = process.env.FOREMAN_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "foreman-home-"));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "foreman-proj-")));
    process.env.FOREMAN_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { home: () => home, cwd: () => cwd };
}
