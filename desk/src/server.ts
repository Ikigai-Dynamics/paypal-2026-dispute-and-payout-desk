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
import { init as initActivity, list as listCalls, record } from "./activity.js";
import { DraftCache, pool as runPool } from "./drafts.js";
import {
  acceptClaim,
  parseExtra,
  submitEvidence,
  syncAll,
  ValidationError,
} from "./sync.js";

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
// PayPal activity log for the page; the sync's per-case gets are skipped, its list calls are kept
let syncing = false;
function logged<A extends unknown[], R>(
  method: string,
  path: (...a: A) => string,
  fn: (...a: A) => Promise<R>,
  quietInSync = false,
): (...a: A) => Promise<R> {
  return async (...a) => {
    const t = Date.now();
    let status = 200;
    try {
      return await fn(...a);
    } catch (e) {
      status = e instanceof PayPalApiError ? e.status : 0;
      throw e;
    } finally {
      if (!(quietInSync && syncing))
        record({ method, path: path(...a), status, ms: Date.now() - t });
    }
  };
}
const D = "/v1/customer/disputes";
const d = paypal.disputes;
const rawList = d.list.bind(d);
const rawGet = d.get.bind(d);
const rawEvidence = d.provideEvidence.bind(d);
const rawAccept = d.acceptClaim.bind(d);
d.list = logged("GET", () => D, rawList);
d.get = logged("GET", (id: string) => `${D}/${id}`, rawGet, true);
d.provideEvidence = logged(
  "POST",
  (id: string, ..._: unknown[]) => `${D}/${id}/provide-evidence`,
  rawEvidence,
);
d.acceptClaim = logged(
  "POST",
  (id: string, ..._: unknown[]) => `${D}/${id}/accept-claim`,
  rawAccept,
);
// the gateway loads models on first use, so allow a slow first answer
const llm = createLlm({ timeoutMs: 25000 });
const drafts = new DraftCache(llm);
const pool = new pg.Pool({
  connectionString: process.env["DATABASE_URL"],
  connectionTimeoutMillis: 3000,
  max: 6,
});
pool.on("error", () => {
  /* idle client errors during failover */
});
const store = new PgStore(pool);
initActivity(pool);

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

// online = the last real completion worked, else a probe of the gateway answered
let probe = { at: 0, ok: false };
async function llmOnline(): Promise<boolean> {
  if (!llm.online) return false;
  if (drafts.lastOk !== null) return drafts.lastOk;
  if (Date.now() - probe.at < 30_000) return probe.ok;
  let ok = false;
  try {
    ok = (
      await fetch(
        `${(process.env["LLM_BASE_URL"] ?? "").replace(/\/+$/, "")}/models`,
        {
          headers: { authorization: `Bearer ${process.env["LLM_API_KEY"]}` },
          signal: AbortSignal.timeout(2000),
        },
      )
    ).ok;
  } catch {
    /* gateway down */
  }
  probe = { at: Date.now(), ok };
  return ok;
}

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

// after a sync, draft the open cases nobody has opened yet, most urgent first, two at a time
async function preDraft(): Promise<void> {
  const rows = (await store.list()).filter(
    (r) => r.status === "WAITING_FOR_SELLER_RESPONSE" || r.status === "OPEN",
  ); // store.list is ordered by due date
  await runPool(rows, 2, async (row) => {
    const precedents = await findPrecedents(store, row);
    const o = {
      prior: null,
      handlingCostCents: DEFAULT_HANDLING_CENTS,
      feeIfLostCents: 0,
    };
    const decision = await decideFor({ decideUrl }, row, precedents, o);
    const d = await drafts.get(toView(row), decision, precedents, o);
    return d.source === "llm"; // gateway down: stop instead of waiting out every timeout
  });
}

async function runSync(): Promise<number> {
  syncState.attempts++;
  syncing = true;
  try {
    const n = await syncAll(paypal, store);
    syncState.lastOk = new Date().toISOString();
    syncState.error = null;
    syncState.cases = n;
    log({ msg: "sync ok", cases: n });
    void warmDecisions()
      .then(preDraft)
      .catch((e) => log({ msg: "warm failed", error: String(e) }));
    return n;
  } catch (e) {
    syncState.error = e instanceof Error ? e.message : String(e);
    log({ msg: "sync failed", error: syncState.error });
    throw e;
  } finally {
    syncing = false;
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

const MAX_BODY = 1024 * 1024;
const MAX_EVIDENCE_BODY = 8 * 1024 * 1024;

async function readJson(
  req: IncomingMessage,
  cap = MAX_BODY,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > cap)
      throw new HttpError(413, "too_large", "request body is too large");
    chunks.push(c as Buffer);
  }
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
        llm: {
          online: await llmOnline(),
          label: (await llmOnline()) ? `AI (${llm.model})` : "offline fallback",
        },
        cases: await store.count().catch(() => null),
        decide: { url: decideUrl, reachable: await decideReachable() },
        search: "Postgres full-text",
        sync: syncState,
        pod: process.env["POD_NAME"] ?? null,
      },
    };
  if (m === "GET" && p === "/api/paypal-activity")
    return { status: 200, body: { calls: await listCalls(20) } };
  if (m === "POST" && p === "/api/sync") {
    const n = await runSync();
    return { status: 200, body: { synced: n } };
  }
  if (m === "GET" && p === "/api/cases") {
    const rows = await store.list();
    const now = Date.now();
    const open = (r: { status: string }) =>
      r.status === "WAITING_FOR_SELLER_RESPONSE" || r.status === "OPEN";
    const views = rows.map((r) => toView(r, now));
    const currency =
      [
        ...views.reduce(
          (m, v) => m.set(v.currency, (m.get(v.currency) ?? 0) + 1),
          new Map<string, number>(),
        ),
      ].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
    const late = (v: { days_left: number | null }) =>
      v.days_left !== null && v.days_left < 0;
    const needs = views.filter((v) => open(v) && !late(v));
    return {
      status: 200,
      body: {
        summary: {
          total: views.length,
          needs_response: needs.length,
          under_review: views.filter((v) => v.status === "UNDER_REVIEW").length,
          closed: views.filter((v) => v.status === "RESOLVED").length,
          missed_deadline: views.filter((v) => open(v) && late(v)).length,
          at_stake_cents: needs
            .filter((v) => v.currency === currency)
            .reduce((n, v) => n + v.amount_cents, 0),
          currency,
        },
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
            item: v.items[0]?.item_description ?? null,
            item_quantity: v.items[0]?.item_quantity ?? null,
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
      const out = await analyse(
        {
          store,
          llm,
          decideUrl,
          draft: (v, dc, pr, o) => drafts.get(v, dc, pr, o),
        },
        row,
        {
          prior: prior ?? null,
          handlingCostCents: c ?? DEFAULT_HANDLING_CENTS,
          feeIfLostCents: fee ?? 0,
        },
      );
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
      const b = await readJson(
        req,
        a[2] === "evidence" ? MAX_EVIDENCE_BODY : MAX_BODY,
      );
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
        let extra;
        try {
          extra = parseExtra(b);
        } catch (e) {
          if (e instanceof ValidationError)
            throw new HttpError(400, "bad_request", e.message);
          throw e;
        }
        row = await submitEvidence(paypal, store, id, text, extra);
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
    llmConfigured: llm.online,
  }),
);

process.on("SIGTERM", () => {
  draining = true;
  server.close(() => void pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
});
