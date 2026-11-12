import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { SESSION_MS, createDemoLimits } from "../src/demo-limits.js";

const req = (method: string, cookie?: string) =>
  ({ method, headers: cookie ? { cookie } : {} }) as IncomingMessage;
const cookieOf = (v: any) => String(v.setCookie).split(";")[0]!;

describe("demo limits", () => {
  it("needs a session for data, and ends it after 10 minutes", () => {
    let t = 1_000_000;
    const g = createDemoLimits(() => t);
    assert.equal((g.check(req("GET"), "/api/cases", "1.1.1.1") as any).code, "demo_expired");
    assert.equal(g.check(req("GET"), "/api/info", "1.1.1.1").ok, true);
    const s = g.check(req("POST"), "/api/demo/start", "1.1.1.1");
    const c = cookieOf(s);
    assert.equal(g.check(req("GET", c), "/api/cases", "1.1.1.1").ok, true);
    t += SESSION_MS + 1;
    assert.equal((g.check(req("GET", c), "/api/cases", "1.1.1.1") as any).code, "demo_expired");
  });

  it("refuses a forged cookie", () => {
    const g = createDemoLimits(() => 5);
    assert.equal((g.check(req("GET", "parley_demo=5.forged"), "/api/cases", "ip") as any).code, "demo_expired");
  });

  it("limits new sessions and AI calls per address, and resets for everybody", () => {
    let t = 0;
    const g = createDemoLimits(() => t);
    let c = "";
    for (let i = 0; i < 3; i++) {
      t += SESSION_MS + 1;
      c = cookieOf(g.check(req("POST"), "/api/demo/start", "a"));
    }
    t += SESSION_MS + 1;
    assert.equal((g.check(req("POST"), "/api/demo/start", "a") as any).status, 429);
    assert.equal(g.check(req("POST"), "/api/demo/start", "b").ok, true);
    t = 0; // a fresh guard for the AI and reset counts
    const h = createDemoLimits(() => t);
    c = cookieOf(h.check(req("POST"), "/api/demo/start", "a"));
    for (let i = 0; i < 30; i++) assert.equal(h.check(req("POST", c), "/api/chat/conversations", "a").ok, true);
    assert.equal((h.check(req("POST", c), "/api/cases/X/draft", "a") as any).status, 429);
    assert.equal(h.check(req("POST", c), "/api/demo/reset", "a").ok, true);
    assert.equal((h.check(req("POST", c), "/api/demo/reset", "a") as any).status, 429);
  });
});

describe("clientIp", () => {
  it("prefers the edge's header over X-Forwarded-For", async () => {
    const { clientIp } = await import("../src/demo-limits.js");
    const r = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: "10.0.0.9" } }) as unknown as IncomingMessage;
    assert.equal(clientIp(r({ "x-parley-client": "203.0.113.5", "x-forwarded-for": "10.42.0.1" })), "203.0.113.5");
    assert.equal(clientIp(r({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" })), "198.51.100.7");
    assert.equal(clientIp(r({})), "10.0.0.9");
  });
});
