// Public-demo guard (DEMO_LIMITS=1): a 10-minute session per visitor (signed cookie) and per-IP rate limits,
// so strangers cannot spend the AI budget or keep the shared demo for themselves.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_MS = 10 * 60_000;
const COOKIE = "parley_demo";
// shortcut: limits live in memory per pod (replicas = 1); move to Valkey before scaling out
const LIMITS = {
  api: { max: 240, windowMs: 60_000 }, // every /api request
  ai: { max: 30, windowMs: SESSION_MS }, // chat messages, drafts, checks
  start: { max: 3, windowMs: 60 * 60_000 }, // new sessions
};
const RESET_COOLDOWN_MS = 2 * 60_000; // one shared demo: one reset every 2 minutes for everybody
// what works without a session: the page's own status calls, the docs, and PayPal's webhooks
const OPEN = new Set(["/api/info", "/api/demo/session", "/api/demo/start", "/api/webhooks/paypal", "/api/openapi.json", "/api/assumptions"]);
const isAi = (m: string, p: string) =>
  m === "POST" && (p.startsWith("/api/chat/") || /^\/api\/cases\/[^/]+\/(draft|check)$/.test(p));

export type Verdict =
  | { ok: true; setCookie?: string; body?: unknown }
  | { ok: false; status: number; code: string; detail: string; extra?: Record<string, unknown> };

export function createDemoLimits(now: () => number = Date.now, secret = randomBytes(32)) {
  const hits = new Map<string, number[]>();
  let lastReset = -Infinity;

  const sign = (start: number) => createHmac("sha256", secret).update(String(start)).digest("base64url");
  function sessionStart(req: IncomingMessage): number | null {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`).exec(req.headers.cookie ?? "");
    if (!m) return null;
    const a = Buffer.from(m[2]!), b = Buffer.from(sign(Number(m[1])));
    return a.length === b.length && timingSafeEqual(a, b) ? Number(m[1]) : null;
  }
  // a fixed window per key; returns seconds to wait, or 0 when the hit is allowed
  function take(key: string, { max, windowMs }: { max: number; windowMs: number }): number {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return Math.ceil((list[0]! + windowMs - t) / 1000);
    }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 50_000) hits.clear(); // bound memory under a flood
    return 0;
  }
  const limited = (retry: number, what: string): Verdict => ({
    ok: false, status: 429, code: "rate_limited", detail: `Too many ${what}. Try again in ${retry} s.`, extra: { retry_after: retry },
  });
  const state = (start: number | null) => {
    const ends = start === null ? null : start + SESSION_MS;
    return { enabled: true, active: ends !== null && ends > now(), ends_at: ends && new Date(ends).toISOString(), minutes: SESSION_MS / 60_000 };
  };

  /** Called before routing every /api request; ip is the visitor's address. */
  function check(req: IncomingMessage, path: string, ip: string): Verdict {
    const m = req.method ?? "GET";
    let r = take(`api:${ip}`, LIMITS.api);
    if (r) return limited(r, "requests");
    const start = sessionStart(req);
    if (path === "/api/demo/session" && m === "GET") return { ok: true, body: state(start) };
    if (path === "/api/demo/start" && m === "POST") {
      if (state(start).active) return { ok: true, body: state(start) };
      r = take(`start:${ip}`, LIMITS.start);
      if (r) return limited(r, "new demos from your address");
      const t = now();
      return {
        ok: true,
        setCookie: `${COOKIE}=${t}.${sign(t)}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Lax; Secure`,
        body: state(t),
      };
    }
    if (OPEN.has(path)) return { ok: true };
    if (!state(start).active)
      return { ok: false, status: 403, code: "demo_expired", detail: "Your 10-minute demo is over. Start a new one to keep going." };
    if (isAi(m, path) && (r = take(`ai:${ip}`, LIMITS.ai))) return limited(r, "AI requests");
    if (path === "/api/demo/reset" && m === "POST") {
      const wait = lastReset + RESET_COOLDOWN_MS - now();
      if (wait > 0) return limited(Math.ceil(wait / 1000), "resets (someone just reset the demo)");
      lastReset = now();
    }
    return { ok: true };
  }
  return { check };
}

/** The visitor's address. The cluster's ingress rewrites X-Forwarded-For to its own neighbour, so the public
 * edge (Caddy) stamps X-Parley-Client, overwriting whatever the visitor sent. */
export const clientIp = (req: IncomingMessage) =>
  String(req.headers["x-parley-client"] ?? "").trim() ||
  String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() ||
  req.socket.remoteAddress ||
  "unknown";
