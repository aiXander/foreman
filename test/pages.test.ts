// Pages (docs/TODO/01_pages.md, P1 + P1b): foreman_page mounting, the page listener (reads, and
// the page's own writes to declared files), the page origin vs the daemon, tells (host gate +
// daemon route) and pins that outlive sessions — real daemon, real journals, no ptyd, no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "foreman-pages-"));
process.env.FOREMAN_HOME = home;
process.env.FOREMAN_CLAUDE_SESSIONS_DIR = join(home, "no-claude-registry");

const { Auth, loadOrCreateSecret } = await import("../src/daemon/auth");
const { Projection } = await import("../src/daemon/projection");
const { PtydLink } = await import("../src/daemon/terminals");
const { Hub } = await import("../src/daemon/hub");
const { serve } = await import("../src/daemon/server");
const { Trays } = await import("../src/daemon/trays");
const { StopControl } = await import("../src/daemon/stopper");
const { Pins, ignoredChange, startPrompt } = await import("../src/daemon/pins");
const { etagOf, pageHandler, servedFile, WRITE_LIMITS } = await import("../src/daemon/page-server");
const { PageEdits } = await import("../src/daemon/page-edits");
const { registerSessionEnd, registerSessionStart } = await import("../src/shared/registration");
const { callTool } = await import("../src/shared/tools");
const { foldJournal } = await import("../src/shared/reducer");
const { sessionJournal } = await import("../src/shared/store");
const { paths } = await import("../src/shared/paths");
const { Journal } = await import("../src/shared/journal");
const { TellGate, TELL_RATE } = await import("../src/ui/tell");

const port = 20000 + Math.floor(Math.random() * 20000);
const config = { version: 1 as const, bind: "127.0.0.1" as const, port, page_port: port + 1, extra_origins: [], claude_executable: "/usr/bin/true" };
const pageOrigin = `http://localhost:${port + 1}`;
const proj = realpathSync(mkdtempSync(join(tmpdir(), "foreman-pages-proj-")));
let secret: string;
let bearer: Record<string, string>;
let server: ReturnType<typeof serve>;
let projection: InstanceType<typeof Projection>;
let hub: InstanceType<typeof Hub>;
let ptyd: InstanceType<typeof PtydLink>;
let pins: InstanceType<typeof Pins>;
let edits: InstanceType<typeof PageEdits>;

beforeAll(async () => {
  secret = loadOrCreateSecret();
  bearer = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  projection = new Projection();
  ptyd = new PtydLink();
  pins = new Pins(pageOrigin);
  edits = new PageEdits(pins);
  const trays = new Trays();
  hub = new Hub(projection, ptyd, null, trays, null, pins);
  projection.start();
  await ptyd.start();
  hub.start();
  server = serve({ config, auth: new Auth(secret, config), hub, projection, ptyd, trays, stops: new StopControl(ptyd), pins, edits });
  mkdirSync(join(proj, "ui"));
  writeFileSync(join(proj, "ui", "index.html"), "<!doctype html><p>counter</p>");
  writeFileSync(join(proj, "ui", "count.json"), '{"n":1}');
  writeFileSync(join(proj, "ui", ".env"), "SECRET=1");
  mkdirSync(join(proj, "ui", ".git"));
  writeFileSync(join(proj, "ui", ".git", "config"), "x");
  writeFileSync(join(proj, "outside.txt"), "not in the page folder");
  writeFileSync(join(proj, "notes.txt"), "x");
});

afterAll(() => {
  server.stop(true);
  hub.stop();
  pins.stop();
  ptyd.stop();
  projection.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

let n = 0;
function session(cwd = proj) {
  const native = `pages-${++n}-${crypto.randomUUID()}`;
  const reg = registerSessionStart({ session_id: native, cwd, source: "startup" });
  const call = (tool: string, input: Record<string, unknown>) => callTool(tool, { target: reg.target, request_id: crypto.randomUUID(), ...input }, { source: "cli" }) as any;
  return { ...reg, native, call };
}
const refresh = (...ids: string[]) => {
  for (const id of ids) projection.refresh(id);
  hub.recompute();
};
const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = bearer) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const pinFor = (path: string) => pins.all().find((p) => p.path === path) ?? null;

describe("foreman_page", () => {
  test("mounts an .html file under the cwd by realpath; refuses missing, non-html, dotfile, escapes and symlinks out", () => {
    const a = session();
    expect(a.call("foreman_page", { path: "ui/index.html", title: "Counter" }).result).toMatchObject({ page: join(proj, "ui", "index.html"), title: "Counter" });
    const code = (path: string) => a.call("foreman_page", { path }).code;
    expect(code("ui/missing.html")).toBe("VALIDATION");
    expect(code("ui/count.json")).toBe("VALIDATION");
    writeFileSync(join(proj, "ui", ".hidden.html"), "x");
    expect(code("ui/.hidden.html")).toBe("VALIDATION");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "foreman-elsewhere-")));
    writeFileSync(join(elsewhere, "p.html"), "x");
    expect(code(join(elsewhere, "p.html"))).toBe("VALIDATION");
    expect(code(`../${elsewhere.split("/").pop()}/p.html`)).toBe("VALIDATION");
    symlinkSync(join(elsewhere, "p.html"), join(proj, "link-out.html"));
    expect(code("link-out.html")).toBe("VALIDATION");
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a throwaway page under the session's own pages dir mounts; null unmounts", () => {
    const a = session();
    mkdirSync(paths.sessionPages(a.session), { recursive: true });
    const page = join(paths.sessionPages(a.session), "scratch.html");
    writeFileSync(page, "<p>scratch</p>");
    expect(a.call("foreman_page", { path: page }).result).toMatchObject({ title: "scratch" });
    expect(a.call("foreman_page", { path: null }).result).toEqual({ page: null });
    expect(foldJournal(sessionJournal(a.session).readAll())!.page).toBeNull();
  });

  test("page.set survives replay: a fresh fold and the projection show the same page", async () => {
    const a = session();
    a.call("foreman_page", { path: "ui/index.html", title: "Counter" });
    const s = foldJournal(sessionJournal(a.session).readAll())!;
    expect(s.page).toMatchObject({ path: join(proj, "ui", "index.html"), title: "Counter" });
    refresh(a.session);
    const v = (await req("GET", `/sessions/${a.session}`)).body.session;
    expect(v.page).toMatchObject({ path: join(proj, "ui", "index.html"), title: "Counter" });
    expect(v.page.url).toStartWith(`${pageOrigin}/p/`);
    expect(v.page.url).toEndWith("/index.html");
  });
});

describe("page listener", () => {
  test("servedFile: escapes, encoded escapes, dotfiles, dot dirs, directories and symlinks out are refused", () => {
    const root = join(proj, "ui");
    expect(servedFile(root, "count.json")).toBe(join(root, "count.json"));
    for (const bad of ["../outside.txt", "%2e%2e/outside.txt", "..%2Foutside.txt", ".env", ".git/config", "%2egit/config", "", "sub/", ".", "a//b", "%E0%A4%A"]) {
      expect(servedFile(root, bad)).toBeNull();
    }
    mkdirSync(join(root, "dir"), { recursive: true });
    expect(servedFile(root, "dir")).toBeNull();
    symlinkSync(join(proj, "outside.txt"), join(root, "out-link.txt"));
    symlinkSync(join(root, ".env"), join(root, "env-link.txt"));
    expect(servedFile(root, "out-link.txt")).toBeNull();
    expect(servedFile(root, "env-link.txt")).toBeNull();
  });

  test("GET/HEAD only, own Host only, own Origin only; files carry the page CSP and no cookie", async () => {
    const a = session();
    a.call("foreman_page", { path: "ui/index.html" });
    refresh(a.session);
    const pin = pinFor(join(proj, "ui", "index.html"))!;
    const url = `http://localhost:${port + 1}/p/${pin.token}/count.json`;
    const handle = pageHandler(config, pins);
    const get = (u: string, init: RequestInit & { headers?: Record<string, string> } = {}) => handle(new Request(u, { ...init, headers: { Host: `localhost:${port + 1}`, ...init.headers } }));
    const ok = await get(url);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ n: 1 });
    const csp = ok.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain(`frame-ancestors http://127.0.0.1:${port}`);
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect((await get(url, { method: "HEAD" })).status).toBe(200);
    for (const method of ["POST", "PATCH", "DELETE", "OPTIONS"]) expect((await get(url, { method, body: method === "OPTIONS" ? undefined : "{}" })).status).toBe(405);
    expect((await get(url, { headers: { Host: `evil.example:${port + 1}` } })).status).toBe(403);
    expect((await get(url, { headers: { Host: `127.0.0.1:${port + 1}` } })).status).toBe(403);
    expect((await get(url, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await get(url, { headers: { Origin: pageOrigin } })).status).toBe(200);
    expect((await get(`http://localhost:${port + 1}/p/${"A".repeat(43)}/count.json`)).status).toBe(404);
    expect((await get(`http://localhost:${port + 1}/p/${pin.token}/.env`)).status).toBe(404);
    expect((await get(`http://localhost:${port + 1}/p/${pin.token}/`)).status).toBe(404);
  });

  test("the page origin can't use the daemon: its Origin is refused on every route, and the sign-in cookie is host-only on 127.0.0.1", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/auth/launch-token`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const res = await fetch(((await r.json()) as any).url, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie")!;
    // No Domain attribute: the browser scopes it to the exact host 127.0.0.1, never "localhost".
    expect(setCookie.toLowerCase()).not.toContain("domain=");
    expect(new URL(pageOrigin).hostname).not.toBe("127.0.0.1");
    const cookie = setCookie.split(";")[0]!;
    const a = session();
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/api/v1/sessions"],
      ["GET", "/api/v1/events"],
      ["POST", `/api/v1/sessions/${a.session}/tell`],
      ["PUT", `/api/v1/sessions/${a.session}/tray`],
      ["POST", "/api/v1/terminals"],
    ] as const) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Cookie: cookie, Origin: pageOrigin, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect([method, path, r.status]).toEqual([method, path, 403]);
    }
  });

  test("the host's CSP may frame only the page origin", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    const csp = r.headers.get("content-security-policy");
    if (csp) expect(csp).toContain(`frame-src ${pageOrigin}`); // absent only when the UI isn't built
  });
});

describe("tell gate (host)", () => {
  const frame = {};
  const tell = (over: Partial<{ source: unknown; origin: string; data: unknown }> = {}) => ({ source: frame, origin: pageOrigin, data: { type: "foreman:tell", text: "bump" }, ...over });

  test("only our own frame's window and the page origin count; other messages are ignored", () => {
    const g = new TellGate(pageOrigin);
    expect(g.check(tell(), frame, true).kind).toBe("send");
    expect(g.check(tell({ source: {} }), frame, true).kind).toBe("ignore");
    expect(g.check(tell({ origin: "http://evil.example" }), frame, true).kind).toBe("ignore");
    expect(g.check(tell({ origin: `http://127.0.0.1:${port + 1}` }), frame, true).kind).toBe("ignore");
    expect(g.check(tell({ data: { type: "other" } }), frame, true).kind).toBe("ignore");
    expect(g.check(tell(), null, true).kind).toBe("ignore");
  });

  test("no human action, empty, oversize and runaway pages are refused", () => {
    const g = new TellGate(pageOrigin);
    expect(g.check(tell(), frame, false).kind).toBe("refuse");
    expect(g.check(tell({ data: { type: "foreman:tell", text: "  " } }), frame, true).kind).toBe("refuse");
    expect(g.check(tell({ data: { type: "foreman:tell", text: "x".repeat(9000) } }), frame, true).kind).toBe("refuse");
    const t0 = 1_000_000;
    for (let i = 0; i < TELL_RATE.count; i++) expect(g.check(tell(), frame, true, t0 + i).kind).toBe("send");
    expect(g.check(tell(), frame, true, t0 + 10).kind).toBe("refuse");
    expect(g.check(tell(), frame, true, t0 + TELL_RATE.windowMs + 10).kind).toBe("send");
  });
});

describe("tell route", () => {
  test("a tell becomes one note batch marked from-page; replay-safe; not bound or ended → no agent", async () => {
    const a = session();
    a.call("foreman_page", { path: "ui/index.html", title: "Counter" });
    refresh(a.session);
    const pin = pinFor(join(proj, "ui", "index.html"))!;
    expect(pin.session).toBe(a.session);
    const batch_id = crypto.randomUUID();
    const body = { batch_id, pin_id: pin.pin_id, text: "bump the counter", context: { n: 1 } };
    const r = await req("POST", `/sessions/${a.session}/tell`, body);
    expect(r.status).toBe(200);
    const b = foldJournal(sessionJournal(a.session).readAll())!.work.batches[batch_id]!;
    expect(b.via).toBe("page");
    expect(b.actions).toEqual([{ type: "note", action_id: batch_id, text: '[page Counter] bump the counter\ncontext: {"n":1}' }]);
    expect((await req("POST", `/sessions/${a.session}/tell`, body)).body.replayed).toBe(true);
    refresh(a.session);
    const detail = (await req("GET", `/sessions/${a.session}`)).body;
    expect(detail.batches[0].via).toBe("page");
    expect((await req("POST", `/sessions/${a.session}/tell`, { ...body, batch_id: crypto.randomUUID(), text: "x".repeat(2000) })).status).toBe(400);

    // Another session mounts the same file: the pin moves there; the old session is refused.
    const b2 = session();
    b2.call("foreman_page", { path: join(proj, "ui", "index.html") });
    refresh(b2.session);
    expect(pinFor(join(proj, "ui", "index.html"))!.session).toBe(b2.session);
    const refused = await req("POST", `/sessions/${a.session}/tell`, { ...body, batch_id: crypto.randomUUID() });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("No agent");

    registerSessionEnd({ session_id: b2.native });
    refresh(b2.session);
    const ended = await req("POST", `/sessions/${b2.session}/tell`, { ...body, batch_id: crypto.randomUUID() });
    expect(ended.status).toBe(409);
    expect(ended.body.error).toContain("No agent");
  });

  test("the daemon caps tells per pin", async () => {
    mkdirSync(join(proj, "rate"), { recursive: true });
    writeFileSync(join(proj, "rate", "page.html"), "x");
    const a = session();
    a.call("foreman_page", { path: "rate/page.html" });
    refresh(a.session);
    const pin = pinFor(join(proj, "rate", "page.html"))!;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await req("POST", `/sessions/${a.session}/tell`, { batch_id: crypto.randomUUID(), pin_id: pin.pin_id, text: `t${i}` })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("pins", () => {
  test("a pin outlives its session, survives a daemon restart without re-applying, rebinds only on an explicit mount", async () => {
    mkdirSync(join(proj, "crm"), { recursive: true });
    const page = join(proj, "crm", "board.html");
    writeFileSync(page, "<p>board</p>");
    const a = session();
    a.call("foreman_page", { path: page, title: "Board" });
    refresh(a.session);
    const first = pinFor(page)!;
    registerSessionEnd({ session_id: a.native });
    refresh(a.session);
    const listed = (await req("GET", "/sessions")).body.pins.find((p: any) => p.pin_id === first.pin_id);
    expect(listed).toMatchObject({ title: "Board", session: a.session, path: page, cwd: proj });

    // A new session in the same folder doesn't take the pin by cwd or recency.
    const b = session();
    refresh(b.session);
    expect(pinFor(page)!.session).toBe(a.session);

    // Restart: a fresh Pins over the same file re-applies nothing.
    const events = () => new Journal(paths.uiJournal(), paths.uiLock()).readAll().filter((e) => e.type.startsWith("pin."));
    const before = events().length;
    const again = new Pins(pageOrigin);
    expect(again.sync(projection.states())).toBe(false);
    expect(events().length).toBe(before);

    // Mounting it is the explicit bind: same pin, same token, new session.
    b.call("foreman_page", { path: "crm/board.html" });
    refresh(b.session);
    expect(pinFor(page)).toMatchObject({ pin_id: first.pin_id, token: first.token, session: b.session });

    // Unmount releases it; hide drops it from the sidebar until the next mount.
    b.call("foreman_page", { path: null });
    refresh(b.session);
    expect(pinFor(page)!.session).toBeNull();
    expect((await req("POST", `/pins/${first.pin_id}/hide`, {})).status).toBe(200);
    refresh();
    expect((await req("GET", "/sessions")).body.pins.some((p: any) => p.pin_id === first.pin_id)).toBe(false);
  });

  test("a change in the page folder reports the pin (debounced); dotfiles and temp files don't", async () => {
    mkdirSync(join(proj, "watched"), { recursive: true });
    const page = join(proj, "watched", "index.html");
    writeFileSync(page, "x");
    const a = session();
    a.call("foreman_page", { path: page });
    refresh(a.session);
    const pin = pinFor(page)!;
    const seen: string[] = [];
    const off = pins.onPageChange((id) => seen.push(id));
    await Bun.sleep(100);
    writeFileSync(join(proj, "watched", "data.json"), '{"n":2}');
    for (let i = 0; i < 40 && !seen.includes(pin.pin_id); i++) await Bun.sleep(50);
    off();
    expect(seen.filter((id) => id === pin.pin_id).length).toBe(1);
    expect(ignoredChange(".git/index")).toBe(true);
    expect(ignoredChange("data.json.tmp")).toBe(true);
    expect(ignoredChange("sub/.data.json.swp")).toBe(true);
    expect(ignoredChange("sub/data.json")).toBe(false);
  });
});

describe("page writes (P1b)", () => {
  /** A fresh page folder mounted by a new session with `writable`; returns the pin and a PUT/GET client. */
  function mounted(name: string, writable: string[] = ["count.json", "notes.md", "inbox/", "new.json"]) {
    const dir = join(proj, name);
    mkdirSync(join(dir, "inbox"), { recursive: true });
    mkdirSync(join(dir, "inbox", "sub"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>counter v2</p>");
    writeFileSync(join(dir, "count.json"), '{"n":1}');
    writeFileSync(join(dir, "notes.md"), "# notes");
    writeFileSync(join(dir, "app.js"), "1");
    const a = session();
    const r = a.call("foreman_page", { path: `${name}/index.html`, title: name, writable });
    expect(r.ok).toBe(true);
    refresh(a.session);
    const pin = pinFor(join(dir, "index.html"))!;
    const handle = pageHandler(config, pins, edits);
    const url = (rel: string) => `http://localhost:${port + 1}/p/${pin.token}/${rel}`;
    const base = { Host: `localhost:${port + 1}`, Origin: pageOrigin, "Content-Type": "application/json" };
    const put = (rel: string, body: string, headers: Record<string, string | null> = {}) => {
      const h = Object.fromEntries(Object.entries({ ...base, ...headers }).filter(([, v]) => v !== null)) as Record<string, string>;
      return handle(new Request(url(rel), { method: "PUT", headers: h, body }));
    };
    const get = (rel: string, method = "GET") => handle(new Request(url(rel), { method, headers: { Host: base.Host } }));
    const etag = async (rel: string) => (await get(rel)).headers.get("etag")!;
    return { a, dir, pin, put, get, etag };
  }

  test("foreman_page validates writable: relative, inside the folder, no dot segments, no code, no symlinks; dirs must exist", () => {
    mkdirSync(join(proj, "wv", "inbox"), { recursive: true });
    mkdirSync(join(proj, "wv", "data"), { recursive: true });
    writeFileSync(join(proj, "wv", "index.html"), "x");
    writeFileSync(join(proj, "wv", "count.json"), "{}");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "foreman-wv-")));
    writeFileSync(join(elsewhere, "x.json"), "{}");
    symlinkSync(join(elsewhere, "x.json"), join(proj, "wv", "link.json"));
    symlinkSync(elsewhere, join(proj, "wv", "linkdir"));
    const a = session();
    const mount = (writable: unknown) => a.call("foreman_page", { path: "wv/index.html", writable });
    const ok = mount(["count.json", "data/new.json", "inbox/", "count.json"]);
    expect(ok.result.writable).toEqual(["count.json", "data/new.json", "inbox/"]);
    expect(foldJournal(sessionJournal(a.session).readAll())!.page!.writable).toEqual(["count.json", "data/new.json", "inbox/"]);
    for (const bad of [
      [join(proj, "wv", "count.json")],
      ["../count.json"],
      ["data/../count.json"],
      [".env"],
      ["data/.x.json"],
      ["a//b.json"],
      ["index.html"],
      ["app.JS"],
      ["style.css"],
      ["pic.svg"],
      ["mod.wasm"],
      ["missing/"],
      ["count.json/"],
      ["inbox"],
      ["link.json"],
      ["linkdir/"],
      ["linkdir/x.json"],
      ["nodir/x.json"],
      Array.from({ length: 9 }, (_, i) => `f${i}.json`),
    ]) {
      const r = mount(bad);
      expect([bad, r.code, r.field ?? r.error?.field]).toMatchObject([bad, "VALIDATION", "writable"]);
    }
    // Re-mounting replaces the list; omitted = read-only.
    expect(mount(undefined).result.writable).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("page.set with and without writable replays; the pin, views and Start agent carry it", async () => {
    const { a, dir, pin } = mounted("wr");
    const events = sessionJournal(a.session).readAll();
    expect(foldJournal(events)!.page!.writable).toEqual(["count.json", "notes.md", "inbox/", "new.json"]);
    // A P1 journal has no writable field: read-only.
    const p1 = events.map((e) => (e.type === "page.set" ? { ...e, payload: { path: (e.payload as any).path, title: (e.payload as any).title } } : e));
    expect(foldJournal(p1)!.page!.writable).toEqual([]);
    expect(pin.writable).toEqual(["count.json", "notes.md", "inbox/", "new.json"]);
    const v = (await req("GET", `/sessions/${a.session}`)).body.session;
    expect(v.page.writable).toEqual(pin.writable);
    const listed = (await req("GET", "/sessions")).body.pins.find((p: any) => p.pin_id === pin.pin_id);
    expect(listed.writable).toEqual(pin.writable);
    const prompt = startPrompt(listed);
    expect(prompt).toContain(JSON.stringify(join(dir, "index.html")));
    expect(prompt).toContain('writable ["count.json","notes.md","inbox/","new.json"]');
    expect(startPrompt({ ...listed, writable: [] })).not.toContain("writable");
  });

  test("PUT refuses undeclared, code, dot, escaping, symlinked and nested targets with 404", async () => {
    const { dir, put, etag } = mounted("wp", ["count.json", "inbox/", "linked.json", "index.html"].filter((w) => w !== "index.html"));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "foreman-wp-")));
    writeFileSync(join(elsewhere, "linked.json"), "{}");
    symlinkSync(join(elsewhere, "linked.json"), join(dir, "linked.json"));
    const create = { "If-None-Match": "*" };
    for (const rel of [
      "index.html",
      "app.js",
      "other.json",
      "inbox/x.js",
      "inbox/x.svg",
      "inbox/x.css",
      "inbox/.hidden",
      "inbox/_x.json",
      "inbox/sub/x.json",
      "../outside.txt",
      "%2e%2e/outside.txt",
      "..%2Fcount.json",
      "inbox/%2e%2e%2Fcount.json",
      "inbox%2F..%2Fapp.js",
      "linked.json",
      "%E0%A4%A",
    ]) {
      expect([rel, (await put(rel, "{}", create)).status]).toEqual([rel, 404]);
    }
    expect(readFileSync(join(elsewhere, "linked.json"), "utf8")).toBe("{}");
    expect((await put("count.json", '{"n":2}', { "If-Match": await etag("count.json") })).status).toBe(200);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("PUT refuses a foreign Host, a foreign or missing Origin, wrong Content-Type, bad JSON, oversize; OPTIONS is 405", async () => {
    const { put, etag, pin } = mounted("wh");
    const m = { "If-Match": await etag("count.json") };
    expect((await put("count.json", "{}", { ...m, Host: `127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await put("count.json", "{}", { ...m, Origin: "http://evil.example" })).status).toBe(403);
    expect((await put("count.json", "{}", { ...m, Origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await put("count.json", "{}", { ...m, Origin: null })).status).toBe(403);
    expect((await put("count.json", "{}", { ...m, "Content-Type": "text/html" })).status).toBe(415);
    expect((await put("count.json", "{}", { ...m, "Content-Type": null })).status).toBe(415);
    expect((await put("count.json", '{"n":', m)).status).toBe(400);
    expect((await put("count.json", "x".repeat(WRITE_LIMITS.maxBytes + 1), { ...m, "Content-Type": "text/plain" })).status).toBe(413);
    const handle = pageHandler(config, pins);
    const options = await handle(new Request(`http://localhost:${port + 1}/p/${pin.token}/count.json`, { method: "OPTIONS", headers: { Host: `localhost:${port + 1}`, Origin: pageOrigin, "Access-Control-Request-Method": "PUT" } }));
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    // Markdown into a declared .md file is fine; the JSON check applies to .json only.
    expect((await put("notes.md", "# new", { "If-Match": await etag("notes.md"), "Content-Type": "text/markdown; charset=utf-8" })).status).toBe(200);
  });

  test("ETags: GET/HEAD carry them; 428 without If-Match, 412 on stale (with the current one), create needs If-None-Match: *", async () => {
    const { dir, put, get, etag } = mounted("we");
    const first = await get("count.json");
    const tag = first.headers.get("etag")!;
    expect(tag).toBe(etagOf(readFileSync(join(dir, "count.json"))));
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await get("count.json", "HEAD")).headers.get("etag")).toBe(tag);
    expect((await put("count.json", '{"n":2}')).status).toBe(428);
    const ok = await put("count.json", '{"n":2}', { "If-Match": tag });
    expect(ok.status).toBe(200);
    const next = ok.headers.get("etag")!;
    expect(next).not.toBe(tag);
    expect(await etag("count.json")).toBe(next);
    expect(readFileSync(join(dir, "count.json"), "utf8")).toBe('{"n":2}');
    const stale = await put("count.json", '{"n":3}', { "If-Match": tag });
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe(next);
    expect((await put("count.json", '{"n":3}', { "If-None-Match": "*" })).status).toBe(412);
    // Create: a declared file that doesn't exist yet, and a drop into the inbox.
    expect((await put("new.json", "{}")).status).toBe(428);
    expect((await put("new.json", "{}", { "If-Match": tag })).status).toBe(412);
    const created = await put("new.json", '{"a":1}', { "If-None-Match": "*" });
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe(etagOf(Buffer.from('{"a":1}')));
    expect((await put("new.json", "{}", { "If-None-Match": "*" })).status).toBe(412);
    expect((await put("inbox/meeting-2026-10-08.md", "# transcript", { "If-None-Match": "*", "Content-Type": "text/markdown" })).status).toBe(201);
    expect(readFileSync(join(dir, "inbox", "meeting-2026-10-08.md"), "utf8")).toBe("# transcript");
  });

  test("writes are atomic (no .tmp left) and keep the last 5 old versions in Foreman's home", async () => {
    const { dir, pin, put, etag } = mounted("wb");
    for (let i = 2; i <= 8; i++) expect((await put("count.json", `{"n":${i}}`, { "If-Match": await etag("count.json") })).status).toBe(200);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(join(dir, "count.json"), "utf8")).toBe('{"n":8}');
    const backups = readdirSync(paths.pageBackups(pin.pin_id)).sort();
    expect(backups.length).toBe(5);
    expect(backups.every((f) => f.startsWith("count.json.20"))).toBe(true);
    expect(readFileSync(join(paths.pageBackups(pin.pin_id), backups.at(-1)!), "utf8")).toBe('{"n":7}');
    expect(readFileSync(join(paths.pageBackups(pin.pin_id), backups[0]!), "utf8")).toBe('{"n":3}');
    // A create has nothing to back up; nothing lands in the user's folder.
    expect((await put("inbox/a.txt", "x", { "If-None-Match": "*", "Content-Type": "text/plain" })).status).toBe(201);
    expect(existsSync(join(dir, "count.json.bak"))).toBe(false);
    expect(readdirSync(paths.pageBackups(pin.pin_id)).length).toBe(5);
  });

  test("the write rate is capped per pin", async () => {
    const { put } = mounted("wl");
    const statuses: number[] = [];
    for (let i = 0; i <= WRITE_LIMITS.count; i++) statuses.push((await put("count.json", "{}")).status);
    expect(statuses.slice(0, WRITE_LIMITS.count).every((s) => s === 428)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test("the page's own write doesn't reload its frame; an external edit of the same file does", async () => {
    const { dir, pin, put, etag } = mounted("ws");
    const seen: string[] = [];
    const off = pins.onPageChange((id) => id === pin.pin_id && seen.push(id));
    const settle = async (want: number) => {
      for (let i = 0; i < 40 && seen.length < want; i++) await Bun.sleep(50);
      await Bun.sleep(400);
    };
    await Bun.sleep(150);
    expect((await put("count.json", '{"n":2}', { "If-Match": await etag("count.json") })).status).toBe(200);
    expect((await put("inbox/drop.json", "{}", { "If-None-Match": "*" })).status).toBe(201);
    await settle(1);
    expect(seen.length).toBe(0);
    writeFileSync(join(dir, "count.json"), '{"n":4}');
    await settle(1);
    off();
    expect(seen.length).toBe(1);
  });
});

describe("edit diff on delivery (P2b)", () => {
  const record = (id: string, star = false, touch = "2026-10-20") => `    {\n      "id": "${id}",\n      "name": "${id.toUpperCase()}",\n      "star": ${star},\n      "next_touch": "${touch}",\n      "stage": "contacted"\n    }`;
  const doc = (recs: string[]) => `{\n  "version": 1,\n  "contacts": [\n${recs.join(",\n")}\n  ]\n}\n`;
  const ids = ["alpha", "voka", "omega"];

  function crm(name: string) {
    const dir = join(proj, name);
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>crm</p>");
    writeFileSync(join(dir, "contacts.json"), doc(ids.map((i) => record(i))));
    const a = session();
    expect(a.call("foreman_page", { path: `${name}/index.html`, title: "CRM", writable: ["contacts.json", "inbox/"] }).ok).toBe(true);
    refresh(a.session);
    const pin = pinFor(join(dir, "index.html"))!;
    const handle = pageHandler(config, pins, edits);
    const url = (rel: string) => `http://localhost:${port + 1}/p/${pin.token}/${rel}`;
    const headers = { Host: `localhost:${port + 1}`, Origin: pageOrigin, "Content-Type": "application/json" };
    const etag = async (rel: string) => (await handle(new Request(url(rel), { headers: { Host: headers.Host } }))).headers.get("etag")!;
    const save = async (body: string) => (await handle(new Request(url("contacts.json"), { method: "PUT", headers: { ...headers, "If-Match": await etag("contacts.json") }, body }))).status;
    const drop = async (rel: string, body: string) => (await handle(new Request(url(rel), { method: "PUT", headers: { ...headers, "Content-Type": "text/markdown", "If-None-Match": "*" }, body }))).status;
    const tell = async (text: string) => {
      const batch_id = crypto.randomUUID();
      const r = await req("POST", `/sessions/${a.session}/tell`, { batch_id, pin_id: pin.pin_id, text });
      expect(r.status).toBe(200);
      return foldJournal(sessionJournal(a.session).readAll())!.work.batches[batch_id]!;
    };
    return { a, dir, pin, save, drop, tell };
  }

  test("page saves since the last batch ride on the next one as a line diff naming the record; then they're gone", async () => {
    const { a, save, drop, tell } = crm("crm1");
    expect(await save(doc([record("alpha"), record("voka", true), record("omega")]))).toBe(200);
    expect(await save(doc([record("alpha"), record("voka", true, "2026-10-27"), record("omega")]))).toBe(200);
    expect(await drop("inbox/2026-10-08-voka-ab12.md", "record: voka\nhello")).toBe(201);
    const b = await tell("what did I just change?");
    expect(b.edits).not.toBeNull();
    expect(b.text.startsWith(b.edits!)).toBe(true);
    expect(b.text).toContain("1. Note: [page CRM] what did I just change?");
    expect(b.edits).toContain('@@ -13,4 +13,4 @@ "contacts" › "id": "voka"');
    expect(b.edits).toContain('-      "star": false,\n-      "next_touch": "2026-10-20",\n+      "star": true,\n+      "next_touch": "2026-10-27",');
    expect(b.edits).toContain("inbox/2026-10-08-voka-ab12.md: new file (18 B), not shown");
    expect(b.edits).not.toContain("hello");
    // The card shows it.
    refresh(a.session);
    expect((await req("GET", `/sessions/${a.session}`)).body.batches[0].edits).toBe(b.edits);
    const next = await tell("and now?");
    expect(next.edits).toBeNull();
  });

  test("an agent edit between two page saves stays out of the diff", async () => {
    const { dir, save, tell } = crm("crm2");
    expect(await save(doc([record("alpha", true), record("voka"), record("omega")]))).toBe(200);
    // The agent edits another record (not through the page).
    writeFileSync(join(dir, "contacts.json"), doc([record("alpha", true), record("voka"), record("omega", false, "2027-01-01")]));
    expect(await save(doc([record("alpha", true), record("voka"), record("omega", false, "2027-01-01")]).replace('"stage": "contacted"', '"stage": "won"'))).toBe(200);
    const b = await tell("x");
    expect(b.edits).toContain('"id": "alpha"');
    expect(b.edits).toContain('+      "stage": "won"');
    expect(b.edits).not.toContain("2027-01-01");
  });

  test("over the budget: hunks that fit, then a summary line; a rebound pin (fresh agent) starts empty", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `r${i}`);
    const { a, pin, dir, save, tell } = crm("crm3");
    writeFileSync(join(dir, "contacts.json"), doc(many.map((i) => record(i))));
    expect(await save(doc(many.map((i) => record(i, true))))).toBe(200);
    const b = await tell("x");
    expect(Buffer.byteLength(b.edits!)).toBeLessThan(3000);
    expect(b.edits).toMatch(/contacts\.json: \d+ more changes not shown \(\+\d+ −\d+ lines\); read the file, or `git diff contacts.json` if the folder is in git/);

    expect(await save(doc(many.map((i) => record(i, false))))).toBe(200);
    const fresh = session();
    expect(fresh.call("foreman_page", { path: join(dir, "index.html"), title: "CRM", writable: ["contacts.json", "inbox/"] }).ok).toBe(true);
    refresh(fresh.session, a.session);
    expect(pinFor(pin.path)!.session).toBe(fresh.session);
    const r = await req("POST", `/sessions/${fresh.session}/tell`, { batch_id: crypto.randomUUID(), pin_id: pin.pin_id, text: "hi" });
    expect(r.status).toBe(200);
    const fb = Object.values(foldJournal(sessionJournal(fresh.session).readAll())!.work.batches)[0]!;
    expect(fb.edits).toBeNull();
  });
});


describe("Start / Fresh agent (P2a)", () => {
  test("launches first with the pin's folder and mount prompt, then ends the old managed agent; replay never ends the new one", async () => {
    const dir = join(proj, "fresh");
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>crm</p>");
    writeFileSync(join(dir, "contacts.json"), "{}");
    const native = `fresh-${crypto.randomUUID()}`;
    const old = crypto.randomUUID(); // the bound agent's terminal
    const reg = registerSessionStart({ session_id: native, cwd: proj, source: "startup" }, { FOREMAN_TERMINAL_ID: old });
    expect(callTool("foreman_page", { target: reg.target, request_id: crypto.randomUUID(), path: "fresh/index.html", title: "CRM", writable: ["contacts.json", "inbox/"] }, { source: "cli" }).ok).toBe(true);
    refresh(reg.session);
    const pin = pinFor(join(dir, "index.html"))!;
    expect(pin.session).toBe(reg.session);

    const launched: any[] = [];
    const killed: string[] = [];
    const orig = { launch: ptyd.launch, kill: ptyd.kill };
    let fail = false;
    ptyd.launch = (async (r: any) => {
      if (fail) throw new Error("ptyd down");
      launched.push(r);
      return { terminal_id: r.request_id };
    }) as any;
    ptyd.kill = (async (id: string) => (killed.push(id), { signaled: true })) as any;
    ptyd.terminals.set(old, { terminal_id: old, state: "live", target: reg.target } as any);
    try {
      const request_id = crypto.randomUUID();
      const r = await req("POST", `/pins/${pin.pin_id}/agent`, { request_id });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ terminal_id: request_id, previous: "ended" });
      expect(launched[0].cwd).toBe(pin.cwd);
      expect(launched[0].prompt).toBe(startPrompt(pin));
      expect(launched[0].prompt).toContain('writable ["contacts.json","inbox/"]');
      expect(killed).toEqual([old]);

      // The new agent mounts the page itself (its page.set rebinds the pin); a replayed click
      // returns the same terminal and never ends it.
      const b = registerSessionStart({ session_id: `fresh-${crypto.randomUUID()}`, cwd: proj, source: "startup" }, { FOREMAN_TERMINAL_ID: request_id });
      callTool("foreman_page", { target: b.target, request_id: crypto.randomUUID(), path: "fresh/index.html", title: "CRM", writable: ["contacts.json", "inbox/"] }, { source: "cli" });
      refresh(b.session);
      expect(pinFor(pin.path)!.session).toBe(b.session);
      expect(pinFor(pin.path)!.writable).toEqual(["contacts.json", "inbox/"]);
      ptyd.terminals.set(request_id, { terminal_id: request_id, state: "live", target: b.target } as any);
      expect((await req("POST", `/pins/${pin.pin_id}/agent`, { request_id })).body.previous).toBe("none");
      expect(killed).toEqual([old]);
      // A tell reaches the new agent.
      expect((await req("POST", `/sessions/${b.session}/tell`, { batch_id: crypto.randomUUID(), pin_id: pin.pin_id, text: "hi" })).status).toBe(200);

      // A failed launch leaves the bound agent alone.
      fail = true;
      expect((await req("POST", `/pins/${pin.pin_id}/agent`, { request_id: crypto.randomUUID() })).status).toBe(500);
      expect(killed).toEqual([old]);
      fail = false;

      // An observed agent can't be ended from here: launch anyway and say so.
      const o = session();
      o.call("foreman_page", { path: "fresh/index.html", title: "CRM", writable: ["contacts.json"] });
      refresh(o.session);
      expect((await req("POST", `/pins/${pin.pin_id}/agent`, { request_id: crypto.randomUUID() })).body.previous).toBe("not_managed");
      expect(killed).toEqual([old]);
      expect((await req("POST", `/pins/${crypto.randomUUID()}/agent`, { request_id: crypto.randomUUID() })).status).toBe(404);
    } finally {
      Object.assign(ptyd, orig);
    }
  });
});
