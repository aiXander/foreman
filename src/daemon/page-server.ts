// The page listener (pages plan, item 2 + P1b): mounted pages on a second loopback origin,
// `http://localhost:<page_port>`. A different host name from the daemon's 127.0.0.1, because
// cookies ignore ports: the page never carries Foreman's sign-in cookie, and every daemon route
// refuses its Origin. `GET/HEAD /p/<token>/<path>` serves from the pin's folder (realpath-bounded,
// no dotfiles, no listings) with an ETag. `PUT /p/<token>/<path>` lets the page save one of the
// data files its agent declared writable: whole-file replace, only if still the version it read,
// atomically, with the old bytes kept in Foreman's home. Nothing record-shaped: bytes in, bytes out.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Server } from "bun";
import type { Config } from "../shared/config";
import { ensureDir, paths } from "../shared/paths";
import { badSegment, writableCovers } from "../shared/writable";
import type { PageEdits } from "./page-edits";
import type { Pin, Pins } from "./pins";

/** Where a page may load code and fonts from besides its own folder: a short, pinned CDN list. */
const SCRIPT_CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";

export const WRITE_LIMITS = { maxBytes: 4 * 1024 * 1024, count: 30, windowMs: 10_000 } as const;
const WRITE_TYPES = new Set(["application/json", "text/plain", "text/markdown"]);
const BACKUPS_KEPT = 5;

export const pageOrigin = (config: Pick<Config, "page_port">) => `http://localhost:${config.page_port}`;

/** A file version as the page sees it: a quoted, truncated sha256 of its bytes. */
export const etagOf = (bytes: Uint8Array) => `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;

function decodeRel(rel: string): string[] | null {
  try {
    const segs = decodeURIComponent(rel).split("/");
    return segs.some(badSegment) ? null : segs;
  } catch {
    return null;
  }
}

/** `real` is strictly inside `root` (both realpaths), with no dot segment on the way. */
const within = (root: string, real: string) => {
  const inside = relative(root, real);
  return inside !== "" && !inside.split(sep).some((s) => s === ".." || s.startsWith("."));
};

/**
 * The file `rel` (URL-encoded, relative to the pin's folder) names, or null. Dot segments and
 * dotfiles are refused before and after resolving symlinks, and the realpath must stay inside
 * the folder's realpath.
 */
export function servedFile(root: string, rel: string): string | null {
  const segs = decodeRel(rel);
  if (!segs) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(realRoot, ...segs));
    return within(realRoot, real) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Where a PUT of `rel` may write, or null: a declared writable file or a direct child of a declared
 * writable directory, by the served-file segment rules, whose folder resolves inside the pin's
 * folder. A target that exists must be a regular file, not a symlink.
 */
function writeTarget(root: string, rel: string, writable: readonly string[]): { abs: string; rel: string; exists: boolean } | null {
  const segs = decodeRel(rel);
  if (!segs || !writableCovers(writable, segs.join("/"))) return null;
  try {
    const realRoot = realpathSync(root);
    const parent = realpathSync(join(realRoot, ...segs.slice(0, -1)));
    if (parent !== realRoot && !within(realRoot, parent)) return null;
    const abs = join(parent, segs.at(-1)!);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (st && !st.isFile()) return null;
    return { abs, rel: segs.join("/"), exists: !!st };
  } catch {
    return null;
  }
}

function pageHeaders(config: Pick<Config, "bind" | "port" | "extra_origins">): Record<string, string> {
  const ancestors = [`http://${config.bind}:${config.port}`, ...config.extra_origins].join(" ");
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${SCRIPT_CDNS}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${ancestors}`,
    ].join("; "),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/** fsync a file or directory by path. */
function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write `bytes` to a temp file beside `abs` and fsync it; returns the temp path. */
function writeTemp(abs: string, bytes: Uint8Array): string {
  const tmp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** Keep the replaced bytes under `ui/page-backups/<pin>/<rel with / → __>.<timestamp>`; the last few per file. */
function backup(pin: Pin, rel: string, old: Uint8Array): void {
  const dir = ensureDir(paths.pageBackups(pin.pin_id));
  const flat = rel.replaceAll("/", "__");
  const stamp = new Date().toISOString().replaceAll(":", "-");
  let name = `${flat}.${stamp}`;
  for (let i = 1; statSync(join(dir, name), { throwIfNoEntry: false }); i++) name = `${flat}.${stamp}-${i}`;
  writeFileSync(join(dir, name), old, { mode: 0o600 });
  const mine = new RegExp(`^${flat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d\\d-\\d\\dT`);
  const kept = readdirSync(dir).filter((f) => mine.test(f)).sort();
  for (const f of kept.slice(0, -BACKUPS_KEPT)) rmSync(join(dir, f), { force: true });
}

/** A refusal: status, message, extra headers. */
type Refusal = [number, string, Record<string, string>?];
const METHODS = new Set(["GET", "HEAD", "PUT"]);

/** What a PUT is refused for before its body is read: not our page's Origin, a type we don't store, too big. */
function putHeaderRefusal(h: Headers, origin: string): Refusal | null {
  // Browsers always send Origin on a non-GET fetch; no Origin means it isn't our page.
  if (h.get("origin") !== origin) return [403, "origin not allowed"];
  const type = (h.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!WRITE_TYPES.has(type)) return [415, "Content-Type must be application/json, text/plain or text/markdown"];
  if (Number(h.get("content-length") ?? 0) > WRITE_LIMITS.maxBytes) return [413, "too large (4 MiB max)"];
  return null;
}

/** A `.json` target must at least parse: a guard against a truncated body, not domain validation. */
function badJson(rel: string, body: Uint8Array): boolean {
  if (!rel.toLowerCase().endsWith(".json")) return false;
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return false;
  } catch {
    return true;
  }
}

/** Replace needs `If-Match: <current>`; create needs `If-None-Match: *`. */
function versionRefusal(current: string | null, h: Headers): Refusal | null {
  const ifMatch = h.get("if-match");
  const create = h.get("if-none-match") === "*";
  if (!current) {
    if (ifMatch) return [412, "the file no longer exists; create it with If-None-Match: *"];
    return create ? null : [428, "send If-None-Match: * to create a file"];
  }
  const tag = { ETag: current };
  if (create) return [412, "the file exists; read it and send If-Match", tag];
  if (!ifMatch) return [428, "send If-Match with the ETag you read", tag];
  return ifMatch === current ? null : [412, "the file changed since you read it; re-read and re-apply", tag];
}

/**
 * Put `body` in place atomically: a fsynced temp file renamed over the old one (whose bytes go to
 * the backups first), or hard-linked into place for a create (false if the file appeared meanwhile).
 */
function commit(pin: Pin, target: { abs: string; rel: string }, body: Uint8Array, old: Uint8Array | null): boolean {
  const tmp = writeTemp(target.abs, body);
  try {
    if (old) {
      backup(pin, target.rel, old);
      renameSync(tmp, target.abs);
    } else {
      try {
        linkSync(tmp, target.abs); // create only if still absent
      } catch {
        return false;
      }
    }
    fsyncPath(dirname(target.abs));
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The request handler for one listener (exported for tests; `servePages` binds it). It holds the
 * per-pin write rate.
 */
export function pageHandler(config: Config, pins: Pick<Pins, "byToken" | "noteWrite">, edits?: Pick<PageEdits, "record">): (req: Request) => Promise<Response> {
  const headers = pageHeaders(config);
  const origin = pageOrigin(config);
  const writes = new Map<string, number[]>();
  const deny = (status: number, msg: string, extra: Record<string, string> = {}) => new Response(msg, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", ...extra } });

  const read = (req: Request, pin: Pin | null, rel: string): Response => {
    const file = pin ? servedFile(dirname(pin.path), rel) : null;
    if (!file) return deny(404, "not found");
    const bytes = readFileSync(file);
    const type = Bun.file(file).type || "application/octet-stream";
    return new Response(req.method === "HEAD" ? null : bytes, { headers: { ...headers, "Content-Type": type, ETag: etagOf(bytes) } });
  };

  const underRate = (pinId: string) => {
    const now = Date.now();
    const recent = (writes.get(pinId) ?? []).filter((t) => now - t < WRITE_LIMITS.windowMs);
    writes.set(pinId, recent.length < WRITE_LIMITS.count ? [...recent, now] : recent);
    return recent.length < WRITE_LIMITS.count;
  };

  /** A PUT whose headers and size passed: authorize, version-check and commit it. */
  const store = (h: Headers, pin: Pin, rel: string, body: Uint8Array): Response => {
    if (!underRate(pin.pin_id)) return deny(429, "too many writes; slow down");
    const target = writeTarget(dirname(pin.path), rel, pin.writable);
    if (!target) return deny(404, "not found");
    if (badJson(target.rel, body)) return deny(400, "not valid JSON");
    // From the version check to the rename nothing yields, so two page writes can't interleave.
    const old = target.exists ? readFileSync(target.abs) : null;
    const refused = versionRefusal(old ? etagOf(old) : null, h);
    if (refused) return deny(...refused);
    const etag = etagOf(body);
    pins.noteWrite(target.abs, etag);
    if (!commit(pin, target, body, old)) return deny(412, "the file was just created; read it and send If-Match");
    edits?.record(pin, target.rel, old, body); // the agent sees it as a diff on its next batch (P2b)
    console.log(`page write: pin ${pin.pin_id} ${target.rel} ${body.byteLength} bytes`);
    return new Response(null, { status: old ? 200 : 201, headers: { ...headers, ETag: etag } });
  };

  const write = async (req: Request, pin: Pin | null, rel: string): Promise<Response> => {
    const early = putHeaderRefusal(req.headers, origin);
    if (early) return deny(...early);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > WRITE_LIMITS.maxBytes) return deny(413, "too large (4 MiB max)");
    return pin ? store(req.headers, pin, rel, body) : deny(404, "not found");
  };

  return async (req) => {
    // DNS-rebinding guard: only our own host name reaches a page.
    if (req.headers.get("host") !== `localhost:${config.page_port}`) return deny(403, "host not allowed");
    // No CORS headers ever, and OPTIONS is refused: a foreign site's preflight fails.
    if (!METHODS.has(req.method)) return deny(405, "method not allowed", { Allow: "GET, HEAD, PUT" });
    const o = req.headers.get("origin") ?? origin;
    if (o !== origin) return deny(403, "origin not allowed");
    const [, token = "", rel = ""] = new URL(req.url).pathname.match(/^\/p\/([^/]+)\/(.+)$/) ?? [];
    const pin = pins.byToken(token);
    return req.method === "PUT" ? write(req, pin, rel) : read(req, pin, rel);
  };
}

export function servePages(config: Config, pins: Pins, edits: PageEdits): Server<undefined> {
  return Bun.serve({ hostname: config.bind, port: config.page_port, maxRequestBodySize: WRITE_LIMITS.maxBytes + 64 * 1024, fetch: pageHandler(config, pins, edits) });
}
