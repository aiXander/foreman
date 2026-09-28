// HTTP surface: versioned JSON API, SSE stream, terminal WebSocket proxy and the built UI.
// Bun.serve handles WebSocket upgrades itself; everything else goes through Hono.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { Hono } from "hono";
import type { LaunchRequest, SendRequest, SessionDetailResponse, SessionsResponse, TrayPutRequest, WorkView, WsClientFrame, WsServerFrame } from "../shared/api";
import type { Config } from "../shared/config";
import { cancelBatch, createBatch, markReviewed, retargetBatch, retryBatch } from "../shared/delivery";
import { JournalError } from "../shared/journal";
import { LockTimeout } from "../shared/lock";
import { ToolError, type ErrorCode } from "../shared/protocol";
import { foldJournal, type JournalState } from "../shared/reducer";
import { sessionJournal } from "../shared/store";
import { isActionable } from "../shared/work";
import { PtyClient, PtyError } from "../shared/ptyclient";
import { b64, MAX_WRITE_BYTES, type Push, type TerminalInfo } from "../shared/ptyproto";
import { Auth } from "./auth";
import { batchViews, isOrphaned } from "./delivery-view";
import type { Hub } from "./hub";
import type { Projection } from "./projection";
import type { StopControl } from "./stopper";
import type { Trays } from "./trays";
import { HttpError, launchOptions, type PtydLink } from "./terminals";

const UI_DIR = join(import.meta.dir, "..", "..", "dist", "ui");
const WS_BUFFER_LIMIT = 1024 * 1024;
const TOOL_STATUS: Record<ErrorCode, 400 | 404 | 409 | 503> = {
  VALIDATION: 400,
  LIMIT: 400,
  NOT_REGISTERED: 404,
  STALE_TARGET: 409,
  CONFLICT: 409,
  STORAGE_UNAVAILABLE: 503,
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WsData {
  terminalId: string;
  viewerId: string;
  afterSeq?: number;
  streamEpoch?: string;
  client?: PtyClient;
  closed?: boolean;
  /** Serializes this viewer's requests so multi-chunk input can't interleave with later frames. */
  chain?: Promise<void>;
  /** ptyd pushes that arrive before the attach reply; flushed right after `hello`. */
  early?: Push[] | null;
}

export interface Deps {
  config: Config;
  auth: Auth;
  hub: Hub;
  projection: Projection;
  ptyd: PtydLink;
  trays: Trays;
  stops: StopControl;
}

function buildApp(d: Deps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ ok: false, error: err.message }, err.status);
    if (err instanceof PtyError) return c.json({ ok: false, error: err.message, code: err.code }, err.code === "NOT_FOUND" ? 404 : 409);
    if (err instanceof ToolError) return c.json({ ok: false, error: err.message, code: err.code, field: err.field }, TOOL_STATUS[err.code]);
    if (err instanceof LockTimeout || err instanceof JournalError) return c.json({ ok: false, error: err.message, code: "STORAGE_UNAVAILABLE" }, 503);
    console.error(err);
    return c.json({ ok: false, error: "internal error" }, 500);
  });

  // Every request (static included) must come through an allowed Host/Origin.
  app.use("*", async (c, next) => {
    const bad = d.auth.checkTransport(c.req.raw);
    if (bad && !bad.ok) return c.json({ ok: false, error: bad.reason }, bad.status);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });

  app.get("/auth/launch", (c) => {
    if (!d.auth.consumeLaunchToken(c.req.query("t") ?? null)) return c.text("Launch link expired or already used. Run `foreman open` again.", 401);
    c.header("Set-Cookie", d.auth.cookieHeader(d.auth.newCookieValue()));
    c.header("Cache-Control", "no-store");
    return c.redirect("/", 303); // drops the token from the address bar and history entry
  });

  app.use("/api/*", async (c, next) => {
    const mutating = c.req.method !== "GET" && c.req.method !== "HEAD";
    const r = d.auth.check(c.req.raw, { requireOrigin: mutating });
    if (!r.ok) return c.json({ ok: false, error: r.reason }, r.status);
    if (c.req.path === "/api/v1/auth/launch-token" && r.via !== "bearer") return c.json({ ok: false, error: "bearer only" }, 403);
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.post("/api/v1/auth/launch-token", (c) => {
    const token = d.auth.issueLaunchToken();
    return c.json({ ok: true, url: `${d.auth.origin}/auth/launch?t=${encodeURIComponent(token)}` });
  });

  app.get("/api/v1/sessions", (c) => {
    const snap = d.hub.snapshot();
    const body: SessionsResponse = { ...snap, terminals: [...d.ptyd.terminals.values()] };
    return c.json(body);
  });

  app.get("/api/v1/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = d.hub.view(id);
    if (!session) throw new HttpError(404, "no such session");
    const state = UUID_RE.test(id) ? d.projection.get(id) : null;
    const body: SessionDetailResponse = {
      session,
      activity: state ? [...state.activity].reverse() : [],
      batches: state ? batchViews(state) : [],
      work: state ? workView(state) : { brief: null, progress: null, items: [], handover: null },
      tray: state ? d.trays.view(state) : { revision: 0, batch_id: null, actions: [], preview: null, preview_bytes: 0, blocked: "This session can't be steered from Foreman." },
    };
    return c.json(body);
  });

  // ---- steering (plan §9.1): tray edits, Send, Pause, Stop, batch cancel/retarget, decision review.
  // Every decision is made against the session journal (never the projection).

  app.put("/api/v1/sessions/:id/tray", async (c) => {
    const s = journalState(c.req.param("id"));
    const body = await jsonBody<Partial<TrayPutRequest>>(c.req.raw);
    const tray = d.trays.put(s, body.expected_revision as number, body.actions);
    d.hub.recompute();
    return c.json({ ok: true, tray });
  });

  app.post("/api/v1/sessions/:id/send", async (c) => {
    const s = journalState(c.req.param("id"));
    const body = await jsonBody<Partial<SendRequest>>(c.req.raw);
    if (!isUuid(body.batch_id) || !Number.isInteger(body.tray_revision)) throw new HttpError(400, "batch_id (UUID) and tray_revision are required");
    const r = d.trays.send(s, body.batch_id, body.tray_revision!);
    d.hub.recompute();
    return c.json({ ok: true, ...r });
  });

  app.post("/api/v1/sessions/:id/pause", async (c) => {
    const id = c.req.param("id");
    const s = journalState(id);
    const body = await jsonBody<{ batch_id?: string }>(c.req.raw);
    if (!isUuid(body.batch_id)) throw new HttpError(400, "batch_id (UUID) is required");
    if (!s.run) throw new HttpError(409, "The session has no run to pause.");
    const view = d.hub.view(id);
    // An observed session is only reachable through its hooks: with no turn running, a Pause would
    // sit queued until the human's next prompt made it moot. Say so now instead (D18).
    if (!s.work.batches[body.batch_id] && s.mode === "observed" && !BUSY.has(view?.state ?? s.state)) {
      throw new HttpError(409, "Already idle: no turn is running, so there is nothing to pause.");
    }
    const { replayed } = createBatch(id, { batch_id: body.batch_id, run: s.run, kind: "pause", actions: [{ type: "pause", action_id: body.batch_id }] });
    d.hub.recompute();
    return c.json({ ok: true, batch_id: body.batch_id, replayed });
  });

  app.post("/api/v1/sessions/:id/stop", async (c) => {
    const s = journalState(c.req.param("id"));
    const body = await jsonBody<{ request_id?: string }>(c.req.raw);
    if (!isUuid(body.request_id)) throw new HttpError(400, "request_id (UUID) is required");
    const stop = await d.stops.stop(s, body.request_id);
    d.hub.recompute();
    return c.json({ ok: true, stop });
  });

  app.post("/api/v1/sessions/:id/batches/:batch/cancel", (c) => {
    const { id, batch } = c.req.param();
    if (!isUuid(id) || !isUuid(batch)) throw new HttpError(404, "no such batch");
    cancelBatch(id, batch);
    d.hub.recompute();
    return c.json({ ok: true });
  });

  app.post("/api/v1/sessions/:id/batches/:batch/retarget", async (c) => {
    const { id, batch } = c.req.param();
    if (!isUuid(id) || !isUuid(batch)) throw new HttpError(404, "no such batch");
    const body = await jsonBody<{ batch_id?: string }>(c.req.raw);
    if (!isUuid(body.batch_id)) throw new HttpError(400, "batch_id (UUID) for the new batch is required");
    const { replayed } = retargetBatch(id, batch, body.batch_id);
    d.hub.recompute();
    return c.json({ ok: true, batch_id: body.batch_id, replayed });
  });

  app.post("/api/v1/sessions/:id/items/:item/reviewed", async (c) => {
    const { id, item } = c.req.param();
    if (!isUuid(id)) throw new HttpError(404, "no such session");
    const body = await jsonBody<{ revision?: number }>(c.req.raw);
    if (!Number.isInteger(body.revision)) throw new HttpError(400, "revision is required");
    markReviewed(id, item, body.revision!);
    d.hub.recompute();
    return c.json({ ok: true });
  });

  // Explicit human Retry of a stuck delivery (§9.3): a new attempt on the same batch/action ids.
  // Decided against the journal, never the projection; it may duplicate transport (the UI says so).
  app.post("/api/v1/sessions/:id/batches/:batch/retry", (c) => {
    const { id, batch } = c.req.param();
    if (!UUID_RE.test(id) || !UUID_RE.test(batch)) throw new HttpError(404, "no such batch");
    const b = foldJournal(sessionJournal(id).readAll())?.work.batches[batch];
    if (!b) throw new HttpError(404, "no such batch");
    retryBatch(id, batch, { orphaned: isOrphaned(b) });
    d.hub.recompute();
    return c.json({ ok: true });
  });

  app.get("/api/v1/terminals", (c) => c.json({ ptyd: d.ptyd.up, terminals: [...d.ptyd.terminals.values()] }));

  app.get("/api/v1/launch-options", (c) => c.json(launchOptions()));

  app.post("/api/v1/terminals", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<LaunchRequest> | null;
    if (!body || typeof body.request_id !== "string" || !UUID_RE.test(body.request_id) || typeof body.cwd !== "string") {
      throw new HttpError(400, "request_id (UUID) and cwd are required");
    }
    for (const k of Object.keys(body)) if (!["request_id", "cwd", "model", "effort", "prompt"].includes(k)) throw new HttpError(400, `unknown field ${k}`);
    for (const k of ["model", "effort", "prompt"] as const) if (body[k] !== undefined && typeof body[k] !== "string") throw new HttpError(400, `${k} must be a string`);
    const t = await d.ptyd.launch(body as LaunchRequest, launchOptions());
    return c.json({ terminal_id: t.terminal_id });
  });

  app.get("/api/v1/events", (c) => {
    const lastId = c.req.header("last-event-id") ?? c.req.query("after") ?? null;
    const enc = new TextEncoder();
    let close = () => {};
    let ping: ReturnType<typeof setInterval>;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (cursor: number, event: unknown) => {
          try {
            ctrl.enqueue(enc.encode(`id: ${d.hub.epoch}:${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            close();
          }
        };
        const sub = d.hub.subscribe(lastId, send);
        close = () => {
          sub.close();
          clearInterval(ping);
        };
        ctrl.enqueue(enc.encode("retry: 2000\n\n"));
        if (sub.replay === null) send(d.hub.snapshot().cursor, { type: "resync_required", epoch: d.hub.epoch });
        else for (const r of sub.replay) send(r.cursor, r.event);
        ping = setInterval(() => {
          try {
            ctrl.enqueue(enc.encode(": ping\n\n"));
          } catch {
            close();
          }
        }, 15_000);
      },
      cancel() {
        close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
  });

  app.all("/api/*", (c) => c.json({ ok: false, error: "not found" }, 404));

  // Built SPA. Static files carry no secrets; the API above is what's protected.
  app.get("*", async (c) => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    if (rel.includes("..")) return c.notFound();
    const file = join(UI_DIR, rel);
    if (existsSync(file) && !rel.endsWith("/")) return new Response(Bun.file(file), { headers: securityHeaders(rel) });
    const index = join(UI_DIR, "index.html");
    if (!existsSync(index)) return c.text("UI not built. Run `bun run build:ui`.", 503);
    return new Response(Bun.file(index), { headers: securityHeaders("index.html") });
  });

  return app;
}

const isUuid = (x: unknown): x is string => typeof x === "string" && UUID_RE.test(x);
/** Session states in which a turn is running (hook evidence). */
const BUSY = new Set(["working", "waiting_permission", "waiting_input"]);

/** The session's state folded straight from its journal: steering decides against the authority. */
function journalState(id: string): JournalState {
  const s = isUuid(id) ? foldJournal(sessionJournal(id).readAll()) : null;
  if (!s) throw new HttpError(404, "no such session");
  return s;
}

async function jsonBody<T>(req: Request): Promise<T> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "a JSON object body is required");
  return body as T;
}

function workView(s: JournalState): WorkView {
  const w = s.work;
  return {
    brief: w.brief,
    progress: w.progress,
    items: w.item_order.map((id) => ({ ...w.items[id]!, actionable: isActionable(w.items[id]!) })),
    handover: w.handover,
  };
}

function securityHeaders(rel: string): Record<string, string> {
  const h: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (rel.endsWith(".html")) {
    h["Content-Security-Policy"] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    h["Cache-Control"] = "no-store";
  }
  return h;
}

// ---------- terminal WebSocket proxy: one ptyd connection per browser viewer ----------

function sendWs(ws: ServerWebSocket<WsData>, frame: WsServerFrame): void {
  if (ws.data.closed) return;
  if (ws.getBufferedAmount() > WS_BUFFER_LIMIT) {
    // Slow browser: drop it rather than buffer unboundedly; it reconnects and resyncs.
    ws.close(4000, "resync required");
    return;
  }
  ws.send(JSON.stringify(frame));
}

function pushToWs(ws: ServerWebSocket<WsData>, p: Push): void {
  if ("terminal_id" in p && p.terminal_id !== ws.data.terminalId) return;
  switch (p.event) {
    case "snapshot_begin":
      return sendWs(ws, { t: "snapshot_begin", stream_epoch: p.stream_epoch, seq: p.seq, cols: p.cols, rows: p.rows });
    case "snapshot_chunk":
      return sendWs(ws, { t: "snapshot_chunk", data_b64: p.data_b64 });
    case "snapshot_end":
      return sendWs(ws, { t: "snapshot_end", seq: p.seq });
    case "output":
      return sendWs(ws, { t: "output", stream_epoch: p.stream_epoch, seq: p.seq, data_b64: p.data_b64 });
    case "resize":
      return sendWs(ws, { t: "resize", seq: p.seq, cols: p.cols, rows: p.rows });
    case "exit":
      return sendWs(ws, { t: "exit", code: p.code, signal: p.signal });
    case "control":
      return sendWs(ws, { t: "control", writer: p.writer });
    case "resync_required":
      return ws.close(4000, "resync required");
  }
}

const websocket = {
  async open(ws: ServerWebSocket<WsData>) {
    try {
      const client = await PtyClient.connect({ client: "daemon" });
      if (ws.data.closed) return client.close();
      ws.data.client = client;
      ws.data.early = [];
      client.onPush((p) => (ws.data.early ? ws.data.early.push(p) : pushToWs(ws, p)));
      client.onClose(() => ws.close(1011, "terminal host disconnected"));
      const { terminal } = await client.request<{ terminal: TerminalInfo }>({
        op: "attach",
        terminal_id: ws.data.terminalId,
        viewer_id: ws.data.viewerId,
        ...(ws.data.afterSeq !== undefined && ws.data.streamEpoch ? { after_seq: ws.data.afterSeq, stream_epoch: ws.data.streamEpoch } : {}),
      });
      // The UI needs `hello` (with last_seq) before any snapshot/replay frame.
      sendWs(ws, { t: "hello", viewer_id: ws.data.viewerId, terminal });
      const early = ws.data.early ?? [];
      ws.data.early = null;
      for (const p of early) pushToWs(ws, p);
    } catch (e) {
      const err = e as Error & { code?: string };
      sendWs(ws, { t: "error", code: err.code ?? "UNAVAILABLE", message: err.message });
      ws.close(1011, "attach failed");
    }
  },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    ws.data.chain = (ws.data.chain ?? Promise.resolve()).then(() => handleFrame(ws, raw));
  },
  close(ws: ServerWebSocket<WsData>) {
    ws.data.closed = true;
    const client = ws.data.client;
    if (!client) return;
    client.request({ op: "detach", terminal_id: ws.data.terminalId, viewer_id: ws.data.viewerId }).catch(() => {}).finally(() => client.close());
  },
};

async function handleFrame(ws: ServerWebSocket<WsData>, raw: string | Buffer): Promise<void> {
    const client = ws.data.client;
    if (!client) return;
    let f: WsClientFrame;
    try {
      f = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    const base = { terminal_id: ws.data.terminalId, viewer_id: ws.data.viewerId };
    try {
      if (f.t === "input" && typeof f.data === "string") {
        const bytes = new TextEncoder().encode(f.data);
        for (let o = 0; o < bytes.length; o += MAX_WRITE_BYTES) {
          await client.request({ op: "write", ...base, input_id: crypto.randomUUID(), data_b64: b64.encode(bytes.subarray(o, o + MAX_WRITE_BYTES)) });
        }
      } else if (f.t === "resize" && Number.isInteger(f.cols) && Number.isInteger(f.rows)) {
        await client.request({ op: "resize", ...base, cols: f.cols, rows: f.rows });
      } else if (f.t === "control" && ["acquire", "release", "takeover"].includes(f.action)) {
        const r = await client.request<{ writer: string | null }>({ op: "control", ...base, action: f.action });
        sendWs(ws, { t: "control", writer: r.writer });
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      sendWs(ws, { t: "error", code: err.code ?? "ERROR", message: err.message });
    }
}

export function serve(d: Deps): Server<WsData> {
  const app = buildApp(d);
  return Bun.serve<WsData>({
    hostname: d.config.bind,
    port: d.config.port,
    idleTimeout: 0, // SSE streams are long-lived; we ping every 15 s
    websocket,
    fetch(req, server) {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/api\/v1\/terminals\/([0-9a-f-]{36})\/ws$/i);
      if (m) {
        const r = d.auth.check(req, { requireOrigin: true });
        if (!r.ok) return Response.json({ ok: false, error: r.reason }, { status: r.status });
        const after = url.searchParams.get("after_seq");
        const data: WsData = {
          terminalId: m[1]!,
          viewerId: crypto.randomUUID(),
          afterSeq: after !== null && /^\d+$/.test(after) ? Number(after) : undefined,
          streamEpoch: url.searchParams.get("stream_epoch") ?? undefined,
        };
        return server.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req, { server });
    },
  });
}
