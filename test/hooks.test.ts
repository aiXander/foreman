import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "../src/hooks/main.ts");
let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "foreman-hooks-"));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "foreman-proj-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FOREMAN_")) env[k] = v;
  return { ...env, FOREMAN_HOME: home, ...extra };
}

function hook(event: string, input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", HOOK, event], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: event, cwd, transcript_path: "/tmp/t.jsonl", ...input })),
    env: cleanEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

// Read the store in-process against the same temp home.
async function inHome<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.FOREMAN_HOME;
  process.env.FOREMAN_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = prev;
  }
}

async function stateOf(nativeId: string) {
  return inHome(async () => {
    const { lookupNative, sessionJournal } = await import("../src/shared/store");
    const { foldJournal } = await import("../src/shared/reducer");
    const session = lookupNative("claude", nativeId);
    if (!session) return null;
    const events = sessionJournal(session).readAll();
    return { session, events, state: foldJournal(events)! };
  });
}

describe("registration", () => {
  test("SessionStart registers once per conversation and is idempotent in session identity", async () => {
    const r1 = hook("SessionStart", { session_id: "n1", source: "startup", model: "claude-opus" });
    expect(r1.code).toBe(0);
    const a = (await stateOf("n1"))!;
    expect(a.state).toMatchObject({ mode: "observed", model: "claude-opus", state: "starting", project: cwd, native_id: "n1" });
    hook("SessionStart", { session_id: "n1", source: "resume" });
    const b = (await stateOf("n1"))!;
    expect(b.session).toBe(a.session);
    expect(b.events.filter((e) => e.type === "session.created")).toHaveLength(1);
    // resume = new run; the old incarnation is retired as superseded, not merged
    expect(b.state.run).not.toBe(a.state.run);
    expect(b.events.some((e) => e.type === "run.ended" && (e.payload as any).reason === "superseded" && e.run === a.state.run)).toBe(true);
  });

  test("SessionStart injects the Foreman contract on every source, without any target", async () => {
    const contract = (r: { stdout: string }) => {
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      expect(out.hookEventName).toBe("SessionStart");
      return out.additionalContext as string;
    };
    const term = { FOREMAN_TERMINAL_ID: crypto.randomUUID() };
    const first = contract(hook("SessionStart", { session_id: "c1", source: "startup" }, term));
    const t1 = (await stateOf("c1"))!.state.target!;
    expect(first).not.toContain(t1); // the PreToolUse hook stamps it; the model never sees it
    expect(first).toContain("mcp__plugin_foreman_foreman__foreman_brief");
    expect(first).toContain("only end-of-task summary"); // managed: card only (decided 2026-09-28)

    for (const source of ["compact", "resume", "clear"]) {
      expect(contract(hook("SessionStart", { session_id: "c1", source }, term))).toContain("# Foreman contract");
    }
    const obs = contract(hook("SessionStart", { session_id: "c2", source: "startup" }));
    expect(obs).toContain("normal terminal summary AND call foreman_handover"); // observed: summary + card
  });

  test("SessionStart lists same-project peers with their declared goal (§10); none → no peers block", async () => {
    const reg = { FOREMAN_CLAUDE_SESSIONS_DIR: join(home, "no-registry") };
    const context = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(context(hook("SessionStart", { session_id: "p1", source: "startup" }, reg))).not.toContain("Other live sessions");
    await inHome(async () => {
      const { callTool } = await import("../src/shared/tools");
      const target = (await stateOf("p1"))!.state.target!;
      expect(callTool("foreman_brief", { target, request_id: crypto.randomUUID(), goal: "Migrate the cache to SQLite", done_when: "tests pass" }, { source: "cli" }).ok).toBe(true);
    });
    const second = context(hook("SessionStart", { session_id: "p2", source: "startup" }, reg));
    expect(second).toContain("Other live sessions in this project");
    expect(second).toContain("goal: Migrate the cache to SQLite");
    expect(second).toContain("(name unavailable)"); // no live registry row → no address claimed
  });

  test("compaction keeps run and target", async () => {
    hook("SessionStart", { session_id: "n2", source: "startup" });
    const a = (await stateOf("n2"))!;
    hook("SessionStart", { session_id: "n2", source: "compact" });
    const b = (await stateOf("n2"))!;
    expect([b.state.run, b.state.target]).toEqual([a.state.run, a.state.target]);
    expect(b.events.at(-1)!.type).toBe("run.compacted");
  });

  test("managed /clear rebinds the terminal and retires the old conversation's run", async () => {
    const term = { FOREMAN_TERMINAL_ID: crypto.randomUUID(), FOREMAN_LAUNCH_ID: crypto.randomUUID() };
    hook("SessionStart", { session_id: "old", source: "startup" }, term);
    const old = (await stateOf("old"))!;
    expect(old.state).toMatchObject({ mode: "managed", terminal_id: term.FOREMAN_TERMINAL_ID });
    hook("SessionStart", { session_id: "new", source: "clear" }, term);
    const after = (await stateOf("old"))!;
    expect(after.state).toMatchObject({ state: "dead", end_reason: "rebound" });
    const fresh = (await stateOf("new"))!;
    expect(fresh.state).toMatchObject({ mode: "managed", state: "starting" });
    const entry = JSON.parse(readFileSync(join(home, "sessions/by-terminal", `${term.FOREMAN_TERMINAL_ID}.json`), "utf8"));
    expect(entry).toEqual({ session: fresh.session, run: fresh.state.run });
  });

  test("SessionEnd ends the current run once; a later rebind does not end it again", async () => {
    const term = { FOREMAN_TERMINAL_ID: crypto.randomUUID() };
    hook("SessionStart", { session_id: "e1", source: "startup" }, term);
    hook("SessionEnd", { session_id: "e1", reason: "clear" }, term);
    hook("SessionStart", { session_id: "e2", source: "clear" }, term);
    const s = (await stateOf("e1"))!;
    expect(s.state).toMatchObject({ state: "dead", end_reason: "clear" });
    expect(s.events.filter((e) => e.type === "run.ended")).toHaveLength(1);
  });
});

describe("passive activity", () => {
  test("hook events fold into card state; subagent tool calls don't change current_tool", async () => {
    hook("SessionStart", { session_id: "p1", source: "startup" });
    hook("UserPromptSubmit", { session_id: "p1", prompt: "SECRET PROMPT" });
    expect((await stateOf("p1"))!.state.state).toBe("working");

    hook("PreToolUse", { session_id: "p1", tool_name: "Edit", tool_input: { file_path: "/x/a.ts", old_string: "SECRET" } });
    let s = (await stateOf("p1"))!.state;
    expect(s).toMatchObject({ current_tool: "Edit", recent_paths: ["/x/a.ts"] });

    hook("PreToolUse", { session_id: "p1", tool_name: "Grep", agent_id: "sub-1", agent_type: "Explore", tool_input: {} });
    expect((await stateOf("p1"))!.state.current_tool).toBe("Edit");

    hook("PermissionRequest", { session_id: "p1", tool_name: "Bash", tool_input: { command: "rm -rf SECRET" } });
    expect((await stateOf("p1"))!.state.state).toBe("waiting_permission");

    for (let i = 0; i < 3; i++) hook("PostToolUseFailure", { session_id: "p1", tool_name: "Bash", tool_input: { command: "SECRET" }, error: "SECRET" });
    s = (await stateOf("p1"))!.state;
    expect(s).toMatchObject({ state: "working", failure_streak: 3, tool_failures: 3 });

    hook("Notification", { session_id: "p1", notification_type: "idle_prompt", message: "SECRET" });
    hook("Stop", { session_id: "p1", stop_hook_active: false, last_assistant_message: "SECRET" });
    const final = (await stateOf("p1"))!;
    expect(final.state.state).toBe("finishing");

    const raw = readFileSync(join(home, "sessions", final.session, "events.jsonl"), "utf8");
    expect(raw).not.toContain("SECRET"); // prompts, tool inputs, errors, messages are never stored
  });

  test("events for an unregistered session are a silent no-op", async () => {
    const r = hook("PreToolUse", { session_id: "ghost", tool_name: "Read", tool_input: { file_path: "/a" } });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(await stateOf("ghost")).toBeNull();
  });

  test("an unwritable FOREMAN_HOME never breaks Claude: exit 0, only a user-facing systemMessage", () => {
    mkdirSync(join(home, "ro"));
    chmodSync(join(home, "ro"), 0o500);
    const r = Bun.spawnSync(["bun", HOOK, "SessionStart"], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "x", cwd, source: "startup" })),
      env: cleanEnv({ FOREMAN_HOME: join(home, "ro", "home") }),
      stdout: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout.toString()))).toEqual(["systemMessage"]);
    const passive = Bun.spawnSync(["bun", HOOK, "PreToolUse"], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "x", cwd })),
      env: cleanEnv({ FOREMAN_HOME: join(home, "ro", "home") }),
      stdout: "pipe",
    });
    expect([passive.exitCode, passive.stdout.toString()]).toEqual([0, ""]);
    chmodSync(join(home, "ro"), 0o700);
  });

  test("malformed stdin exits 0 silently", () => {
    const r = Bun.spawnSync(["bun", HOOK, "Stop"], { stdin: new TextEncoder().encode("{nope"), env: cleanEnv(), stdout: "pipe" });
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, ""]);
    expect(existsSync(join(home, "logs", "hooks.log"))).toBe(true);
  });
});

describe("hook delivery (§9.2)", () => {
  const note = (text: string) => ({ type: "note" as const, action_id: crypto.randomUUID(), text });
  async function queue(nativeId: string, kind: "send" | "pause" = "send", text = "do the thing"): Promise<string> {
    return inHome(async () => {
      const { createBatch } = await import("../src/shared/delivery");
      const s = (await stateOf(nativeId))!;
      const batch_id = crypto.randomUUID();
      createBatch(s.session, { batch_id, run: s.state.run!, kind, actions: [kind === "pause" ? { type: "pause", action_id: crypto.randomUUID() } : note(text)] });
      return batch_id;
    });
  }
  const statusOf = async (nativeId: string, batch: string) =>
    inHome(async () => {
      const { batchStatus } = await import("../src/shared/work");
      return batchStatus((await stateOf(nativeId))!.state.work.batches[batch]!);
    });
  const context = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput;

  test("PostToolUse claims, prints the framed batch, then settles; an empty queue prints nothing", async () => {
    hook("SessionStart", { session_id: "d1", source: "startup" });
    expect(hook("PostToolUse", { session_id: "d1", tool_name: "Read" }).stdout).toBe("");
    const b = await queue("d1", "send", "please also run the tests");
    const out = context(hook("PostToolUseFailure", { session_id: "d1", tool_name: "Bash", error: "x" }));
    expect(out.hookEventName).toBe("PostToolUseFailure");
    expect(out.additionalContext).toStartWith(`[foreman batch ${b}]`);
    expect(out.additionalContext).toContain("please also run the tests");
    const { events } = (await stateOf("d1"))!;
    const types = events.map((e) => e.type);
    expect(types.indexOf("delivery.claimed")).toBeLessThan(types.indexOf("delivery.settled")); // claim before output
    expect(await statusOf("d1", b)).toBe("transport_sent");
    expect(hook("PostToolUse", { session_id: "d1", tool_name: "Read" }).stdout).toBe(""); // delivered once
  });

  test("never inside a subagent; Stop continues only when stop_hook_active is false", async () => {
    hook("SessionStart", { session_id: "d2", source: "startup" });
    const b = await queue("d2");
    expect(hook("PostToolUse", { session_id: "d2", tool_name: "Grep", agent_id: "sub-1" }).stdout).toBe("");
    expect(hook("Stop", { session_id: "d2", stop_hook_active: true }).stdout).toBe("");
    expect(await statusOf("d2", b)).toBe("queued");
    const out = context(hook("Stop", { session_id: "d2", stop_hook_active: false }));
    expect(out).toMatchObject({ hookEventName: "Stop" });
    expect(out.additionalContext).toContain("as you were finishing your turn");
    expect(hook("Stop", { session_id: "d2", stop_hook_active: true }).stdout).toBe(""); // no second continuation
  });

  test("a pause parks the running turn at PostToolUse, is moot at Stop, and parks earlier sends", async () => {
    hook("SessionStart", { session_id: "d3", source: "startup" });
    const early = await queue("d3", "send", "queued before the pause");
    const pause = await queue("d3", "pause");
    expect(context(hook("PostToolUse", { session_id: "d3", tool_name: "Read" })).additionalContext).toContain("Pause:");
    expect(hook("Stop", { session_id: "d3", stop_hook_active: false }).stdout).toBe(""); // earlier send stays parked
    expect(await statusOf("d3", early)).toBe("queued");

    const later = await queue("d3", "send", "the human sends more");
    const next = context(hook("Stop", { session_id: "d3", stop_hook_active: false })).additionalContext;
    expect(next).toContain(`[foreman batch ${early}]`); // a new send releases the parked ones, in order
    expect([await statusOf("d3", pause), await statusOf("d3", later)]).toEqual(["transport_sent", "queued"]);

    const moot = await queue("d3", "pause");
    expect(hook("Stop", { session_id: "d3", stop_hook_active: false }).stdout).toBe("");
    expect(await statusOf("d3", moot)).toBe("cancelled");
  });

  test("UserPromptSubmit corroborates marked batches (id only) and a typed prompt moots a queued pause", async () => {
    hook("SessionStart", { session_id: "d4", source: "startup" });
    const b = await queue("d4");
    const s = (await stateOf("d4"))!;
    await inHome(async () => {
      const { claimNext, settle } = await import("../src/shared/delivery");
      settle(claimNext(s.session, "idle_submit")!, "uncertain", "no busy signal");
    });
    expect(await statusOf("d4", b)).toBe("uncertain");
    hook("UserPromptSubmit", { session_id: "d4", prompt: `[foreman batch ${b}] The human sent this SECRET` });
    expect(await statusOf("d4", b)).toBe("transport_sent"); // the prompt proves the typed submit went in
    const pause = await queue("d4", "pause");
    hook("UserPromptSubmit", { session_id: "d4", prompt: "SECRET: my own new instruction" });
    expect(await statusOf("d4", pause)).toBe("cancelled");
    expect(readFileSync(join(home, "sessions", s.session, "events.jsonl"), "utf8")).not.toContain("SECRET");
  });
});

describe("target stamping (PreToolUse on a Foreman tool)", () => {
  const TOOL = "mcp__plugin_foreman_foreman__foreman_brief";
  const pre = (input: Record<string, unknown>) => {
    const r = hook("PreToolUse", input);
    expect(r.code).toBe(0);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };

  test("stamps the CURRENT run's target over whatever the model sent, and follows /resume", async () => {
    hook("SessionStart", { session_id: "s1", source: "startup" });
    const t1 = (await stateOf("s1"))!.state.target!;
    const out = pre({ session_id: "s1", tool_name: TOOL, tool_input: { goal: "g", target: "made-up" } });
    expect(out).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { goal: "g", target: t1 } });

    hook("SessionStart", { session_id: "s1", source: "resume" });
    const t2 = (await stateOf("s1"))!.state.target!;
    expect(t2).not.toBe(t1);
    expect(pre({ session_id: "s1", tool_name: TOOL, tool_input: {} }).updatedInput.target).toBe(t2);
  });

  test("refuses subagents and unregistered sessions; says nothing for other tools", () => {
    hook("SessionStart", { session_id: "s2", source: "startup" });
    const sub = pre({ session_id: "s2", agent_id: "sub-1", tool_name: TOOL, tool_input: {} });
    expect(sub).toMatchObject({ permissionDecision: "deny" });
    expect(sub.updatedInput).toBeUndefined();
    expect(pre({ session_id: "ghost", tool_name: TOOL, tool_input: {} })).toMatchObject({ permissionDecision: "deny" });
    expect(pre({ session_id: "s2", tool_name: "Read", tool_input: { file_path: "/a" } })).toBeNull();
  });
});
