import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm } from "@jeirslab/llm-client";
import { createPayPalClient, PayPalApiError } from "@jeirslab/paypal-client";
import pg from "pg";
import { analyse, decideFor, findPrecedents, toView } from "./analysis.js";
import { DEFAULT_HANDLING_CENTS } from "./decide-client.js";
import { PgStore } from "./db.js";
import { acceptClaim, submitEvidence, syncAll } from "./sync.js";

const port = Number(process.env["PORT"] ?? 8080);
const decideUrl = process.env["DECIDE_URL"] ?? "http://decide";
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");
const agGrid = join(
  here,
  "..",
  "node_modules",
  "ag-grid-community",
  "dist",
  "ag-grid-community.min.js",
);

const paypal = createPayPalClient();
const llm = createLlm();
const pool = new pg.Pool({
  connectionString: process.env["DATABASE_URL"],
  connectionTimeoutMillis: 3000,
  max: 6,
});
pool.on("error", () => {
  /* idle client errors during failover */
});
const store = new PgStore(pool);

let ready = false;
let draining = false;
const syncState: {
  lastOk: string | null;
  error: string | null;
  attempts: number;
  cases: number;
} = {
  lastOk: null,
  error: null,
  attempts: 0,
  cases: 0,
};
// decisions at the default c and F, shown in the grid's Call column
const decisionCache = new Map<
  string,
  { call: string; margin_cents: number; marginal: boolean }
>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(o: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`,
  );
}

async function warmDecisions(): Promise<void> {
  const rows = (await store.list()).filter(
    (r) => r.status === "WAITING_FOR_SELLER_RESPONSE" || r.status === "OPEN",
  );
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++]!;
      const d = await decideFor(
        { decideUrl },
        row,
        await findPrecedents(store, row),
        {},
      );
      if (d)
        decisionCache.set(row.dispute_id, {
          call: d.call,
          margin_cents: d.margin_cents,
          marginal: d.marginal,
        });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

async function runSync(): Promise<number> {
  syncState.attempts++;
  try {
    const n = await syncAll(paypal, store);
    syncState.lastOk = new Date().toISOString();
    syncState.error = null;
    syncState.cases = n;
    log({ msg: "sync ok", cases: n });
    void warmDecisions().catch((e) =>
      log({ msg: "warm failed", error: String(e) }),
    );
    return n;
  } catch (e) {
    syncState.error = e instanceof Error ? e.message : String(e);
    log({ msg: "sync failed", error: syncState.error });
    throw e;
  }
}

async function boot(): Promise<void> {
  while (!draining) {
    try {
      await store.ensureSchema();
      break;
    } catch (e) {
      log({ msg: "schema not ready", error: String(e) });
      await sleep(2000);
    }
  }
  // ready after the first successful sync, or after 3 failed attempts (the page then says PayPal is unreachable)
  for (let i = 0; i < 3 && !draining; i++) {
    try {
      await runSync();
      break;
    } catch {
      await sleep(2000);
    }
  }
  ready = true;
}
void boot();

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail: string,
  ) {
    super(detail);
  }
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "bad_request", "body is not valid JSON");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serveFile(res: ServerResponse, file: string): boolean {
  if (!existsSync(file)) return false;
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(readFileSync(file));
  return true;
}

const num = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const dollarsToCents = (v: string | null): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 100);
};

async function loadRow(id: string) {
  const row = await store.get(id);
  if (!row)
    throw new HttpError(404, "not_found", `case ${id} is not in the index`);
  return row;
}

async function route(
  req: IncomingMessage,
  url: URL,
): Promise<{ status: number; body: unknown } | "handled"> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  if (m === "GET" && p === "/healthz")
    return { status: 200, body: { status: "ok" } };
  if (m === "GET" && p === "/readyz") {
    const ok = ready && !draining;
    return { status: ok ? 200 : 503, body: { ready: ok } };
  }
  if (m === "GET" && p === "/api/info")
    return {
      status: 200,
      body: {
        paypalEnv: paypal.target.env,
        llm: { online: llm.online },
        cases: await store.count().catch(() => null),
        decide: { url: decideUrl, reachable: await decideReachable() },
        search: "Postgres full-text",
        sync: syncState,
        pod: process.env["POD_NAME"] ?? null,
      },
    };
  if (m === "POST" && p === "/api/sync") {
    const n = await runSync();
    return { status: 200, body: { synced: n } };
  }
  if (m === "GET" && p === "/api/cases") {
    const rows = await store.list();
    const now = Date.now();
    return {
      status: 200,
      body: {
        cases: rows.map((r) => {
          const v = toView(r, now);
          const d = decisionCache.get(r.dispute_id);
          return {
            dispute_id: v.dispute_id,
            reason: v.reason,
            stage: v.stage,
            status: v.status,
            outcome: v.outcome,
            amount_cents: v.amount_cents,
            currency: v.currency,
            buyer: v.buyer,
            due_at: v.due_at,
            days_left: v.days_left,
            evidence_on_file: v.evidence_on_file,
            call: d ? (d.marginal ? `${d.call} (marginal)` : d.call) : null,
            margin_cents: d?.margin_cents ?? null,
          };
        }),
      },
    };
  }
  if (m === "GET" && p === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) throw new HttpError(400, "bad_request", "q is required");
    return {
      status: 200,
      body: { engine: "Postgres full-text", q, hits: await store.search(q) },
    };
  }
  const a = /^\/api\/cases\/([^/]+)\/(analysis|evidence|accept)$/.exec(p);
  if (a) {
    const id = decodeURIComponent(a[1]!);
    if (m === "GET" && a[2] === "analysis") {
      const row = await loadRow(id);
      const prior = num(url.searchParams.get("prior"));
      const c = dollarsToCents(url.searchParams.get("c"));
      const fee = dollarsToCents(url.searchParams.get("fee"));
      const out = await analyse({ store, llm, decideUrl }, row, {
        prior: prior ?? null,
        handlingCostCents: c ?? DEFAULT_HANDLING_CENTS,
        feeIfLostCents: fee ?? 0,
      });
      if (
        out.decision &&
        prior === undefined &&
        c === undefined &&
        fee === undefined
      )
        decisionCache.set(id, {
          call: out.decision.call,
          margin_cents: out.decision.margin_cents,
          marginal: out.decision.marginal,
        });
      return { status: 200, body: out };
    }
    if (m === "POST" && (a[2] === "evidence" || a[2] === "accept")) {
      const b = await readJson(req);
      if (b["confirm"] !== true)
        throw new HttpError(
          400,
          "confirmation_required",
          "send confirm: true to write to PayPal",
        );
      await loadRow(id);
      let row;
      if (a[2] === "evidence") {
        const text = typeof b["text"] === "string" ? b["text"].trim() : "";
        if (!text) throw new HttpError(400, "bad_request", "text is required");
        row = await submitEvidence(paypal, store, id, text);
      } else {
        const note =
          typeof b["note"] === "string" && b["note"].trim()
            ? b["note"].trim()
            : "Accepted by the seller from the desk";
        row = await acceptClaim(paypal, store, id, note);
      }
      decisionCache.delete(id);
      return { status: 200, body: { case: toView(row) } };
    }
  }
  return { status: 404, body: { error: "not_found", detail: `${m} ${p}` } };
}

let decideSeen = { at: 0, ok: false };
async function decideReachable(): Promise<boolean> {
  if (Date.now() - decideSeen.at < 3000) return decideSeen.ok;
  let ok = false;
  try {
    ok = (
      await fetch(`${decideUrl.replace(/\/+$/, "")}/healthz`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    /* unreachable */
  }
  decideSeen = { at: Date.now(), ok };
  return ok;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void (async () => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    let status = 200;
    try {
      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        if (!serveFile(res, join(publicDir, "index.html")))
          send(res, 404, { error: "not_found", detail: "page missing" });
        return;
      }
      if (
        req.method === "GET" &&
        url.pathname === "/vendor/ag-grid-community.min.js"
      ) {
        if (!serveFile(res, agGrid))
          send(res, 404, {
            error: "not_found",
            detail: "ag-grid-community not installed",
          });
        return;
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/app.js" || url.pathname === "/app.css")
      ) {
        if (
          !serveFile(
            res,
            join(publicDir, normalize(url.pathname).replace(/^\/+/, "")),
          )
        )
          send(res, 404, { error: "not_found", detail: url.pathname });
        return;
      }
      const r = await route(req, url);
      if (r === "handled") return;
      status = r.status;
      send(res, r.status, r.body);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        send(res, status, { error: e.code, detail: e.message });
      } else if (e instanceof PayPalApiError) {
        status = 502;
        send(res, status, {
          error: "paypal_error",
          detail: e.message,
          debug_id: e.debugId ?? null,
          paypal_status: e.status,
          issue: e.issue ?? null,
        });
      } else {
        status = 500;
        send(res, status, {
          error: "internal",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      if (
        !url.pathname.startsWith("/healthz") &&
        !url.pathname.startsWith("/readyz")
      )
        log({
          method: req.method,
          path: url.pathname,
          status,
          ms: Date.now() - started,
        });
    }
  })();
});

server.listen(port, () =>
  log({
    msg: "desk listening",
    port,
    paypalEnv: paypal.target.env,
    llmOnline: llm.online,
  }),
);

process.on("SIGTERM", () => {
  draining = true;
  server.close(() => void pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
});
