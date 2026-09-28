// Local access control (plan §16). The browser can drive a terminal, so every API/SSE/WS request
// needs: an allowed Host (DNS-rebinding guard), an exact Origin when one is sent, and either the
// CLI bearer secret or a signed HttpOnly SameSite=Strict cookie. The cookie is bootstrapped by a
// short-lived one-use launch token that `foreman open` puts in the URL once; the redirect drops it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../shared/config";
import { ensureHome, paths } from "../shared/paths";

export const COOKIE = "foreman_session";
const LAUNCH_TOKEN_TTL_MS = 60_000;

export function loadOrCreateSecret(): string {
  ensureHome();
  const file = paths.uiToken();
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < 32) throw new Error(`${file} is malformed`);
  return secret;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type AuthResult = { ok: true; via: "bearer" | "cookie" } | { ok: false; status: 401 | 403; reason: string };

export class Auth {
  readonly origin: string;
  private readonly allowedOrigins: Set<string>;
  private readonly allowedHosts: Set<string>;
  private launchTokens = new Map<string, number>();

  constructor(
    private secret: string,
    config: Config,
  ) {
    this.origin = `http://${config.bind}:${config.port}`;
    this.allowedOrigins = new Set([this.origin, ...config.extra_origins]);
    this.allowedHosts = new Set([`${config.bind}:${config.port}`]);
  }

  private sign(nonce: string): string {
    return createHmac("sha256", this.secret).update(`browser-session:${nonce}`).digest("base64url");
  }

  /** Stateless cookie value: survives daemon restarts, dies when secrets/ui-token rotates. */
  newCookieValue(): string {
    const nonce = randomBytes(16).toString("base64url");
    return `${nonce}.${this.sign(nonce)}`;
  }

  cookieHeader(value: string): string {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
  }

  issueLaunchToken(): string {
    const now = Date.now();
    for (const [t, exp] of this.launchTokens) if (exp < now) this.launchTokens.delete(t);
    const token = randomBytes(24).toString("base64url");
    this.launchTokens.set(token, now + LAUNCH_TOKEN_TTL_MS);
    return token;
  }

  consumeLaunchToken(token: string | null): boolean {
    if (!token) return false;
    const exp = this.launchTokens.get(token);
    this.launchTokens.delete(token);
    return exp !== undefined && exp >= Date.now();
  }

  /** Host and Origin checks, applied to every request including static assets. */
  checkTransport(req: Request): AuthResult | null {
    const host = req.headers.get("host");
    if (!host || !this.allowedHosts.has(host)) return { ok: false, status: 403, reason: "host not allowed" };
    const origin = req.headers.get("origin");
    if (origin !== null && !this.allowedOrigins.has(origin)) return { ok: false, status: 403, reason: "origin not allowed" };
    return null;
  }

  /**
   * Full check for API, SSE and WebSocket requests. Browser state-changing requests and
   * WebSocket upgrades must carry an exact Origin; bearer (CLI) requests carry none.
   */
  check(req: Request, opts: { requireOrigin: boolean }): AuthResult {
    const transport = this.checkTransport(req);
    if (transport) return transport;
    const authz = req.headers.get("authorization");
    if (authz?.startsWith("Bearer ")) {
      return safeEqual(authz.slice(7).trim(), this.secret) ? { ok: true, via: "bearer" } : { ok: false, status: 401, reason: "bad bearer" };
    }
    const cookie = parseCookie(req.headers.get("cookie"))[COOKIE];
    if (!cookie) return { ok: false, status: 401, reason: "not signed in" };
    const [nonce, mac] = cookie.split(".");
    if (!nonce || !mac || !safeEqual(mac, this.sign(nonce))) return { ok: false, status: 401, reason: "bad session cookie" };
    if (opts.requireOrigin && req.headers.get("origin") === null) return { ok: false, status: 403, reason: "origin required" };
    return { ok: true, via: "cookie" };
  }
}

function parseCookie(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
