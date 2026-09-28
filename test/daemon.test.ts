// Daemon security (plan §16) and projection behaviour, against a real server on a random port.
// ptyd is intentionally absent: the daemon must still serve and report it as down.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "foreman-daemon-"));
process.env.FOREMAN_HOME = home;
process.env.FOREMAN_CLAUDE_SESSIONS_DIR = join(home, "no-claude-registry");

const { Auth, loadOrCreateSecret, COOKIE } = await import("../src/daemon/auth");
const { Projection } = await import("../src/daemon/projection");
const { PtydLink } = await import("../src/daemon/terminals");
const { Hub } = await import("../src/daemon/hub");
const { serve } = await import("../src/daemon/server");
const { Trays } = await import("../src/daemon/trays");
const { StopControl } = await import("../src/daemon/stopper");
const { appendSessionEvents } = await import("../src/shared/store");
const { claimNext, createBatch, settle } = await import("../src/shared/delivery");
const { registerSessionStart } = await import("../src/shared/registration");

const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const config = { version: 1 as const, bind: "127.0.0.1" as const, port, extra_origins: [], claude_executable: "/usr/bin/true" };
let secret: string;
let server: ReturnType<typeof serve>;
let projection: InstanceType<typeof Projection>;
let hub: InstanceType<typeof Hub>;
let ptyd: InstanceType<typeof PtydLink>;
let trays: InstanceType<typeof Trays>;
let stops: InstanceType<typeof StopControl>;

beforeAll(async () => {
  secret = loadOrCreateSecret();
  const auth = new Auth(secret, config);
  projection = new Projection();
  ptyd = new PtydLink();
  hub = new Hub(projection, ptyd, null, (trays = new Trays()));
  projection.start();
  await ptyd.start();
  hub.start();
  stops = new StopControl(ptyd);
  server = serve({ config, auth, hub, projection, ptyd, trays, stops });
});

afterAll(() => {
  server.stop(true);
  hub.stop();
  ptyd.stop();
  projection.stop();
  rmSync(home, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...init });

async function signIn(): Promise<string> {
  const r = await api("/api/v1/auth/launch-token", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
  const { url } = (await r.json()) as { url: string };
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  return cookie.split(";")[0]!;
}

describe("auth", () => {
  test("API refuses anonymous, wrong-bearer and hostile-origin requests", async () => {
    expect((await api("/api/v1/sessions")).status).toBe(401);
    expect((await api("/api/v1/sessions", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await api("/api/v1/sessions", { headers: { Authorization: `Bearer ${secret}`, Origin: "http://evil.example" } })).status).toBe(403);
    expect((await api("/api/v1/sessions", { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(200);
  });

  test("DNS-rebinding Host is refused even for static files", async () => {
    const r = await api("/", { headers: { Host: `evil.example:${port}` } });
    expect(r.status).toBe(403);
  });

  test("launch token is single-use; cookie then works for reads but mutations need the exact Origin", async () => {
    const r = await api("/api/v1/auth/launch-token", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const { url } = (await r.json()) as { url: string };
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(401);

    const cookie = await signIn();
    expect(cookie.startsWith(`${COOKIE}=`)).toBe(true);
    expect((await api("/api/v1/sessions", { headers: { Cookie: cookie } })).status).toBe(200);
    const body = JSON.stringify({ request_id: crypto.randomUUID(), cwd: home });
    const noOrigin = await api("/api/v1/terminals", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body });
    expect(noOrigin.status).toBe(403);
    const hostile = await api("/api/v1/terminals", { method: "POST", headers: { Cookie: cookie, Origin: "http://evil.example", "Content-Type": "application/json" }, body });
    expect(hostile.status).toBe(403);
    // Correct origin passes auth; ptyd is down so the launch itself is refused honestly.
    const ok = await api("/api/v1/terminals", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body });
    expect(ok.status).toBe(503);
  });

  test("a forged cookie is rejected", async () => {
    const r = await api("/api/v1/sessions", { headers: { Cookie: `${COOKIE}=abc.def` } });
    expect(r.status).toBe(401);
  });

  test("bearer cannot be minted into a launch token by a cookie holder", async () => {
    const cookie = await signIn();
    const r = await api("/api/v1/auth/launch-token", { method: "POST", headers: { Cookie: cookie, Origin: origin } });
    expect(r.status).toBe(403);
  });

  test("terminal WebSocket upgrade requires auth and exact Origin", async () => {
    const tid = crypto.randomUUID();
    const plain = await api(`/api/v1/terminals/${tid}/ws`, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
    expect(plain.status).toBe(401);
    const cookie = await signIn();
    const hostile = await api(`/api/v1/terminals/${tid}/ws`, {
      headers: { Cookie: cookie, Origin: "http://evil.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
    });
    expect(hostile.status).toBe(403);
  });
});

describe("projection + stream", () => {
  test("journal appends show up in the session list and on SSE, with replay by cursor", async () => {
    const auth = { Authorization: `Bearer ${secret}` };
    const before = (await (await api("/api/v1/sessions", { headers: auth })).json()) as any;
    expect(before.sessions).toEqual([]);

    const session = crypto.randomUUID();
    const run = crypto.randomUUID();
    appendSessionEvents(session, null, "hook", [{ type: "session.created", payload: { vendor: "claude", native_id: "native-1", project: home, cwd: home } }]);
    appendSessionEvents(session, run, "hook", [
      {
        type: "run.started",
        payload: { target: crypto.randomUUID(), source: "startup", mode: "observed", terminal_id: null, launch_id: null, model: "opus", transcript_path: null, claude_pid: null, claude_start: null },
      },
      { type: "activity", payload: { hook: "PermissionRequest", tool: "Bash", paths: [], notification: null, detail: null, agent_id: null } },
    ]);

    let view: any;
    for (let i = 0; i < 40 && !view; i++) {
      await Bun.sleep(50);
      const r = (await (await api("/api/v1/sessions", { headers: auth })).json()) as any;
      view = r.sessions.find((s: any) => s.id === session);
    }
    expect(view.state).toBe("waiting_permission");
    expect(view.mode).toBe("observed");
    expect(view.capabilities.terminal).toBe(false);

    // SSE replay from the pre-append cursor contains the session event.
    const ctrl = new AbortController();
    const res = await api(`/api/v1/events?after=${before.epoch}:${before.cursor}`, { headers: auth, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes(session)) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain(`"type":"session"`);

    // A foreign epoch forces a resync instead of silently missing events.
    const ctrl2 = new AbortController();
    const res2 = await api(`/api/v1/events?after=other:1`, { headers: auth, signal: ctrl2.signal });
    const r2 = res2.body!.getReader();
    let t2 = "";
    while (!t2.includes("resync_required")) t2 += new TextDecoder().decode((await r2.read()).value);
    ctrl2.abort();
  });

  test("the projection rebuilds identically from journals after the cache is deleted", () => {
    const states = JSON.stringify(projection.states());
    const fresh = new Projection(join(home, "rebuild.sqlite"));
    fresh.start();
    expect(JSON.stringify(fresh.states())).toBe(states);
    fresh.stop();
  });
  test("an event from an incompatible journal version stops the fold instead of disappearing", () => {
    const session = crypto.randomUUID();
    appendSessionEvents(session, null, "hook", [{ type: "session.created", payload: { vendor: "claude", native_id: "native-v2", project: home, cwd: home } }]);
    const future = { v: 2, id: crypto.randomUUID(), seq: 2, ts: new Date().toISOString(), session, run: null, source: "hook", type: "run.started", payload: {} };
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(join(home, "sessions", session, "events.jsonl"), JSON.stringify(future) + "\n");
    const p = new Projection(join(home, "versions.sqlite"));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      p.start();
    } finally {
      console.error = orig;
    }
    expect(p.get(session)?.last_seq).toBe(1);
    expect(errors.join("\n")).toContain("failed validation");
    p.stop();
  });

  test("session detail shows each batch's delivery; an uncertain one is retried only by an explicit, origin-checked POST", async () => {
    const reg = registerSessionStart({ session_id: "d-retry", cwd: home, source: "startup" });
    const batch_id = crypto.randomUUID();
    createBatch(reg.session, { batch_id, run: reg.run, kind: "send", actions: [{ type: "note", action_id: crypto.randomUUID(), text: "hello" }] });
    settle(claimNext(reg.session, "post_tool_use")!, "uncertain", "output failed");
    projection.refresh(reg.session);
    hub.recompute();
    const cookie = await signIn();
    const detail = (await (await api(`/api/v1/sessions/${reg.session}`, { headers: { Cookie: cookie } })).json()) as any;
    expect(detail.batches[0]).toMatchObject({ batch_id, status: "uncertain", retryable: true, current_run: true });
    expect(detail.batches[0].warning).toContain("not confirmed");
    expect(detail.session.delivery.held).toMatchObject({ batch_id, reason: "uncertain" });

    const url = `/api/v1/sessions/${reg.session}/batches/${batch_id}/retry`;
    expect((await api(url, { method: "POST", headers: { Cookie: cookie } })).status).toBe(403); // no Origin
    expect((await api(url, { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status).toBe(200);
    expect((await api(url, { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status).toBe(409); // queued now: nothing to retry
    projection.refresh(reg.session);
    const after = (await (await api(`/api/v1/sessions/${reg.session}`, { headers: { Cookie: cookie } })).json()) as any;
    expect(after.batches[0].status).toBe("queued");
    expect(after.session.delivery).toMatchObject({ queued: 1, held: null });
    expect(after.session.delivery.waiting).toContain("idle"); // observed, not working: waits for a hook
  });
});
