// The agent protocol (plan §8) through its real handler (callTool) against real journals in a
// temp FOREMAN_HOME: target validation, idempotency, item lifecycle, limits and receipts.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createBatch } from "../src/shared/delivery";
import { foldJournal } from "../src/shared/reducer";
import { registerSessionStart } from "../src/shared/registration";
import { sessionJournal } from "../src/shared/store";
import { callTool, type ToolContext } from "../src/shared/tools";
import { useTempHome } from "./fixtures/home";

const tmp = useTempHome();

const observed: ToolContext = { source: "mcp", envTerminal: null };
const start = (native: string, env: Record<string, string> = {}, source = "startup") => registerSessionStart({ session_id: native, cwd: tmp.cwd(), source }, env);
const call = (tool: string, input: Record<string, unknown>, ctx: ToolContext = observed) => callTool(tool, { request_id: crypto.randomUUID(), ...input }, ctx) as any;
const work = (session: string) => foldJournal(sessionJournal(session).readAll())!.work;

const question = (target: string, id: string, policy = "proceed", extra: Record<string, unknown> = {}) => ({
  target,
  id,
  title: `Question ${id}`,
  summary: "Which storage engine should the cache use?",
  impact: "med",
  reversibility: "costly",
  expected_revision: 0,
  options: [
    { id: "sqlite", label: "SQLite", consequence: "One file, no server." },
    { id: "pg", label: "Postgres", consequence: "Needs a running server." },
  ],
  default: "sqlite",
  policy,
  ...extra,
});

describe("target validation (§6.2)", () => {
  test("unknown, retired and other-terminal targets are refused; nothing is written to a guessed session", () => {
    expect(call("foreman_brief", { target: crypto.randomUUID(), goal: "g", done_when: "d" }).code).toBe("NOT_REGISTERED");

    const first = start("n1");
    const resumed = start("n1", {}, "resume"); // new run of the same conversation
    const stale = call("foreman_brief", { target: first.target, goal: "g", done_when: "d" });
    expect(stale).toMatchObject({ ok: false, code: "STALE_TARGET", field: "target" });
    expect(call("foreman_brief", { target: resumed.target, goal: "g", done_when: "d" }).ok).toBe(true);

    const term = crypto.randomUUID();
    const managed = start("m1", { FOREMAN_TERMINAL_ID: term });
    // A sidecar in another terminal, or one without a terminal, may not write this managed session.
    expect(call("foreman_brief", { target: managed.target, goal: "g", done_when: "d" }, { source: "mcp", envTerminal: crypto.randomUUID() }).code).toBe("STALE_TARGET");
    expect(call("foreman_brief", { target: managed.target, goal: "g", done_when: "d" }, observed).code).toBe("STALE_TARGET");
    expect(call("foreman_brief", { target: managed.target, goal: "g", done_when: "d" }, { source: "mcp", envTerminal: term }).ok).toBe(true);
    expect(work(managed.session).brief).toMatchObject({ goal: "g" });
    expect(work(first.session).brief).toMatchObject({ goal: "g", revision: 1 }); // only the valid call landed
  });
});

describe("mutations", () => {
  test("request_id makes a retry return the original event; reuse for a different call is a CONFLICT", () => {
    const { target, session } = start("i1");
    const request_id = crypto.randomUUID();
    const a = call("foreman_progress", { target, request_id, progress: 10, confidence: "low", now: "reading" });
    const b = call("foreman_progress", { target, request_id, progress: 10, confidence: "low", now: "reading" });
    expect(b).toMatchObject({ ok: true, event_id: a.event_id, seq: a.seq, result: { progress: 10, replayed: true } });
    expect(call("foreman_progress", { target, request_id, progress: 20, confidence: "low", now: "reading" }).code).toBe("CONFLICT");
    expect(sessionJournal(session).readAll().filter((e) => e.type === "progress.set")).toHaveLength(1);
  });

  test("progress keeps omitted optional fields, clears nulls, and only accepts checklist ids from the brief", () => {
    const { target, session } = start("p1");
    call("foreman_brief", { target, goal: "g", done_when: "d", checklist: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    expect(call("foreman_progress", { target, progress: 5, confidence: "low", now: "x", checked: ["zz"] })).toMatchObject({ code: "VALIDATION", field: "checked" });
    call("foreman_progress", { target, progress: 40, confidence: "med", now: "x", eta_min: [10, 30], phase: "build", checked: ["a", "b"] });
    call("foreman_progress", { target, progress: 35, confidence: "med", now: "y", phase: null });
    expect(work(session).progress).toMatchObject({ progress: 35, eta_min: [10, 30], phase: null, checked: ["a", "b"] });
    // Replanning keeps only the checked ids that survive.
    call("foreman_brief", { target, goal: "g2", done_when: "d", checklist: [{ id: "b", label: "B" }] });
    expect(work(session).progress!.checked).toEqual(["b"]);
  });

  test("items: create at revision 0, replace only at the current revision, kind is fixed", () => {
    const { target, session } = start("it1");
    const note = { target, id: "n", title: "T", summary: "S", impact: "low", reversibility: "easy", expected_revision: 0, body: { kind: "note" } };
    expect(call("foreman_post", note).result).toEqual({ id: "n", revision: 1 });
    expect(call("foreman_post", note)).toMatchObject({ code: "CONFLICT", field: "id" });
    expect(call("foreman_post", { ...note, expected_revision: 5 })).toMatchObject({ code: "CONFLICT", field: "expected_revision" });
    expect(call("foreman_post", { ...note, expected_revision: 1, body: { kind: "deliverable", type: "file", ref: "/a" } })).toMatchObject({ code: "VALIDATION" });
    expect(call("foreman_post", { ...note, expected_revision: 1, summary: "S2" }).result).toEqual({ id: "n", revision: 2 });
    expect(work(session).items.n).toMatchObject({ summary: "S2", revision: 2 });
    expect(call("foreman_post", { ...note, id: "bad id" })).toMatchObject({ code: "VALIDATION", field: "id" });
  });

  test("limits: a 4th open question is refused; updating an existing one never consumes a slot", () => {
    const { target } = start("l1");
    for (const id of ["q1", "q2", "q3"]) expect(call("foreman_ask", question(target, id)).ok).toBe(true);
    expect(call("foreman_ask", question(target, "q4")).code).toBe("LIMIT");
    expect(call("foreman_ask", question(target, "q1", "park", { expected_revision: 1 })).ok).toBe(true);
    call("foreman_resolve", { target, id: "q1", expected_revision: 2, outcome: "withdrawn", reason: "not needed" });
    expect(call("foreman_ask", question(target, "q4")).ok).toBe(true);
  });

  test("resolve: a blocking question never defaults and questions don't 'complete' themselves", () => {
    const { target } = start("r1");
    call("foreman_ask", question(target, "b", "block"));
    expect(call("foreman_resolve", { target, id: "b", expected_revision: 1, outcome: "default_applied", reason: "r" })).toMatchObject({ code: "VALIDATION", field: "outcome" });
    expect(call("foreman_resolve", { target, id: "b", expected_revision: 1, outcome: "completed", reason: "r" })).toMatchObject({ code: "VALIDATION" });
    expect(call("foreman_resolve", { target, id: "b", expected_revision: 1, outcome: "superseded", reason: "r", superseded_by: "nope" })).toMatchObject({ field: "superseded_by" });
    expect(call("foreman_resolve", { target, id: "b", expected_revision: 1, outcome: "withdrawn", reason: "moot" }).result).toEqual({ id: "b", revision: 2, outcome: "withdrawn" });
  });

  test("handover must carry every unresolved actionable item", () => {
    const { target, session } = start("h1");
    call("foreman_ask", question(target, "q"));
    call("foreman_post", { target, id: "fyi", title: "T", summary: "S", impact: "low", reversibility: "easy", expected_revision: 0, body: { kind: "note" } });
    const h = { target, summary_md: "Done.", what_changed: [], how_to_verify: [], evidence: [], docs_touched: [], open_items_carried: [] as string[] };
    expect(call("foreman_handover", h)).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("missing: q") });
    expect(call("foreman_handover", { ...h, open_items_carried: ["q", "fyi"] })).toMatchObject({ code: "VALIDATION" }); // a note isn't open work
    expect(call("foreman_handover", { ...h, open_items_carried: ["q"] }).ok).toBe(true);
    expect(work(session).handover).toMatchObject({ open_items_carried: ["q"], revision: 1 });
  });
});

describe("inbox receipts (§9.3)", () => {
  test("seen then acted: an applied answer closes its question; declined needs a note; receipts never regress", () => {
    const { target, session, run } = start("x1");
    call("foreman_ask", question(target, "q", "block"));
    const answer = crypto.randomUUID();
    const note = crypto.randomUUID();
    const { batch } = createBatch(session, {
      batch_id: crypto.randomUUID(),
      run,
      kind: "send",
      actions: [
        { type: "answer", action_id: answer, item_id: "q", item_revision: 1, option_id: "pg", text: "we already run one" },
        { type: "note", action_id: note, text: "also update the docs" },
      ],
    });
    expect(batch.text).toContain(`[action ${answer}]`);

    const listed = call("foreman_inbox", { target });
    expect(listed.result.batches).toEqual([expect.objectContaining({ batch_id: batch.batch_id, status: "queued", text: batch.text })]);

    const b = batch.batch_id;
    expect(call("foreman_inbox", { target, ack: [{ batch_id: b, state: "acted", action_ids: [note], outcome: "declined" }] })).toMatchObject({ code: "VALIDATION", field: "ack.0.note" });
    expect(call("foreman_inbox", { target, ack: [{ batch_id: b, state: "acted", action_ids: [crypto.randomUUID()], outcome: "applied" }] })).toMatchObject({ code: "VALIDATION" });

    call("foreman_inbox", { target, ack: [{ batch_id: b, state: "seen" }] });
    const acted = call("foreman_inbox", { target, ack: [{ batch_id: b, state: "acted", action_ids: [answer], outcome: "applied" }] });
    expect(acted.result).toMatchObject({ acked: 1, closed_items: ["q"] });
    let w = work(session);
    expect(w.items.q!.resolved).toMatchObject({ outcome: "answered" });
    expect(w.items.q!.human[0]).toMatchObject({ option_id: "pg", outcome: "applied" });

    call("foreman_inbox", { target, ack: [{ batch_id: b, state: "acted", action_ids: [note], outcome: "declined", note: "docs are generated" }] });
    // A late "seen" after everything was acted is a no-op, not a regression.
    const late = call("foreman_inbox", { target, ack: [{ batch_id: b, state: "seen" }] });
    expect(late.result.batches).toEqual([]);
    w = work(session);
    expect(w.batches[b]!.acted[note]).toMatchObject({ outcome: "declined", note: "docs are generated" });
    expect(sessionJournal(session).readAll().filter((e) => e.type === "batch.acked")).toHaveLength(3);
  });

  test("a batch staged against an old item revision is a conflict, not a silent reinterpretation", () => {
    const { target, session, run } = start("x2");
    call("foreman_ask", question(target, "q"));
    call("foreman_ask", question(target, "q", "park", { expected_revision: 1 }));
    expect(() =>
      createBatch(session, { batch_id: crypto.randomUUID(), run, kind: "send", actions: [{ type: "answer", action_id: crypto.randomUUID(), item_id: "q", item_revision: 1, option_id: "pg" }] }),
    ).toThrow(/changed since you staged/);
  });
});

test("the skill's schema reference is regenerated from the validator's schemas", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gen-skill-reference.ts"), "--check"], { stderr: "pipe" });
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});
