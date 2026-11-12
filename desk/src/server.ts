import { randomUUID } from "node:crypto";
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
import {
  analyse,
  decideFor,
  findPrecedents,
  orderCounter,
  requestFor,
  toView,
  viewOf,
} from "./analysis.js";
import { createDecisionCache, wholeDollarsCents } from "./decision-cache.js";
import { chatRoutes } from "./chat.js";
import {
  callAssumptions,
  callDecide,
  DEFAULT_HANDLING_CENTS,
} from "./decide-client.js";
import openapi from "./openapi.json" with { type: "json" };
import { PgStore, type AddedEv } from "./db.js";
import {
  addedSentences,
  claimsOf,
  gateEvidence,
  proofText,
} from "./factcheck.js";
import type { Added, CaseRow, Decision, Draft } from "./types.js";
import {
  evidenceOnFile,
  fallbackDraft,
  LABEL_AI,
  markAdded,
  withAdded,
  LABEL_GROUNDED,
  LABEL_TEMPLATE,
} from "./draft.js";
import { init as initActivity, list as listCalls, record } from "./activity.js";
import { paypalRoutes } from "./paypal-routes.js";
import { clientIp, createDemoLimits } from "./demo-limits.js";
import { DraftCache, pool as runPool, stopAfterDown } from "./drafts.js";
import {
  acceptClaim,
  parseAdded as parseAddedEv,
  parseExtra,
  submitEvidence,
  syncAll,
  TYPES,
  ValidationError,
} from "./sync.js";

const port = Number(process.env["PORT"] ?? 8080);
const decideUrl = process.env["DECIDE_URL"] ?? "http://decide";
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

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
// one call per case: every reader goes through callFor, with the same fixed default options
const DEFAULT_OPTS = {
  prior: null,
  handlingCostCents: DEFAULT_HANDLING_CENTS,
  feeIfLostCents: 0,
};
const decideDeps = {
  decideUrl,
  store,
  orders: orderCounter(paypal),
};
let buildSeen = { at: 0, id: "unknown" };
/** the decide core's contract and assumptions version: a new core build recomputes every call */
async function coreBuild(): Promise<string> {
  if (Date.now() - buildSeen.at < 30_000) return buildSeen.id;
  try {
    const a = await callAssumptions(decideUrl);
    buildSeen = { at: Date.now(), id: `decide.v2@${a.version}` };
  } catch {
    buildSeen.at = Date.now() - 25_000; // keep the last known build, retry in 5 s
  }
  return buildSeen.id;
}
const calls = createDecisionCache({
  compute: async (row) =>
    decideFor(decideDeps, row, await findPrecedents(store, row), DEFAULT_OPTS),
  build: coreBuild,
});
const callFor = calls.callFor;
const decisionCache = calls;

// online = the last real completion worked, or a fresh probe of the gateway answered.
// A failed draft only forces a new probe; it never turns the badge off by itself.
let probe = { at: 0, ok: false };
// the AI cost of the kept draft joins the case's fight cost (set, never added: a retry costs nothing more);
// the cached call is stale only when the stored cents really changed
drafts.onCost = (id, usd) => {
  void store
    .setAiCost(id, usd)
    .then((changed) => {
      if (changed) decisionCache.drop(id);
      record({
        method: "AI",
        path: `${DISPUTES}/${id}#ai-draft`,
        status: 200,
        ms: 0,
        kind: "ai",
        note: `AI wrote a draft reply (${usd < 0.01 ? "under 1¢" : "$" + usd.toFixed(2)})`,
      });
    })
    .catch((e) => log({ msg: "ai cost not stored", error: String(e) }));
};
drafts.onResult = (ok) => {
  if (!ok) probe.at = 0;
};
async function llmOnline(): Promise<boolean> {
  if (!llm.online) return false;
  if (drafts.lastOk === true) return true;
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

/** The display name is all the page ever shows of the model; cost is the sum of the stored per-case AI costs. */
async function llmStatus() {
  const online = await llmOnline();
  const cost = await pool
    .query("select coalesce(sum(usd),0)::float8 as usd from case_ai_cost")
    .then((r) => Number(r.rows[0]?.usd ?? 0))
    .catch(() => 0);
  return {
    online,
    label: online ? "AI" : "offline fallback",
    model: "Parley AI",
    costUsd: cost,
  };
}

/** Raw (non-JSON) body: a CSV download. */
class Raw {
  constructor(
    public type: string,
    public text: string,
    public file?: string,
  ) {}
}
// a leading = + - @ makes a spreadsheet read a cell as a formula
const cell = (v: unknown): string => {
  let t = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@]/.test(t)) t = `'${t}`;
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const toCsv = (rows: Record<string, unknown>[], cols: string[]): string =>
  [cols, ...rows.map((r) => cols.map((c) => r[c]))]
    .map((r) => r.map(cell).join(","))
    .join("\n") + "\n";
/** ?format=csv returns a file; anything else the JSON body. */
const asFormat = (
  url: URL,
  body: unknown,
  rows: Record<string, unknown>[],
  cols: string[],
  file: string,
) =>
  url.searchParams.get("format") === "csv"
    ? new Raw("text/csv; charset=utf-8", toCsv(rows, cols), file)
    : body;
const DISPUTES = "/v1/customer/disputes";
const approved = (
  id: string,
  what: string,
  cents?: number,
  currency?: string,
) =>
  record({
    method: "APPROVE",
    path: `${DISPUTES}/${id}#approved`,
    status: 200,
    ms: 0,
    kind: "approval",
    note: `You approved: ${what}`,
    ...(cents != null ? { amount_cents: cents, currency } : {}),
  });
const dollars = (c: number | null | undefined) =>
  c == null ? "" : (c / 100).toFixed(2);

let BUILD = "dev";
try {
  BUILD = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  ).version;
} catch {
  /* keep dev */
}

/** Everything the desk did, newest first: PayPal calls, Parley's calls, human approvals. */
async function activityEvents() {
  const [logged, rows] = await Promise.all([listCalls(200), store.list()]);
  const by = new Map(rows.map((r) => [r.dispute_id, r]));
  const ev = (
    at: string,
    kind: string,
    id: string | null,
    detail: string,
    status: string | number,
    amount?: number | null,
    currency?: string | null,
  ) => ({
    time: at,
    kind,
    case: id,
    buyer: (id && by.get(id)?.buyer) || null,
    amount: dollars(amount ?? (id ? by.get(id)?.amount_cents : null)),
    currency: currency ?? (id ? (by.get(id)?.currency ?? "") : ""),
    status,
    detail,
  });
  return [
    ...logged.map((c) =>
      ev(
        c.at,
        c.kind,
        c.dispute_id,
        c.kind === "ai" || c.kind === "approval"
          ? (c.note ?? "")
          : `${c.method} ${c.path}${c.note ? ` (${c.note})` : ""}`,
        c.status,
        c.amount_cents,
        c.currency,
      ),
    ),
    ...[...decisionCache.entries()].map(([id, d]) =>
      ev(
        d.at,
        "decision",
        id,
        d.call + (d.offer_cents != null ? ` ${dollars(d.offer_cents)}` : ""),
        "decided",
      ),
    ),
  ].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(o: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`,
  );
}

const waiting = (r: { status: string }) =>
  r.status === "WAITING_FOR_SELLER_RESPONSE" || r.status === "OPEN";

// the headline cases first, then by due date (store.list is ordered by due date)
const FIRST = [
  "PP-D-BIGCHARGEBACK-0002",
  "PP-D-GIFTCARD-0001",
  "PP-D-DUPLICATE-0003",
];
const rank = (id: string) => {
  const i = FIRST.indexOf(id);
  return i < 0 ? FIRST.length : i;
};

let warming: Promise<void> | null = null;
// computes every waiting case's call (cached ones are reused); retries every 5 s for up to 3 min until all have one
function warmDecisions(): Promise<void> {
  return (warming ??= (async () => {
    const until = Date.now() + 180_000;
    for (;;) {
      const rows = (await store.list()).filter(waiting);
      await runPool(rows, 4, async (r) => (await callFor(r), true));
      if (
        rows.every((r) => decisionCache.has(r.dispute_id)) ||
        Date.now() > until
      )
        return;
      await sleep(5000);
    }
  })().finally(() => {
    warming = null;
  }));
}

// draft the open cases nobody has opened yet, headline cases first, two at a time
async function preDraft(only?: Set<string>, attempt = 0): Promise<void> {
  const rows = (await store.list())
    .filter((r) => waiting(r) && (!only || only.has(r.dispute_id)))
    .sort((a, b) => rank(a.dispute_id) - rank(b.dispute_id)); // stable: due-date order within a rank
  const ok = new Set<string>();
  const keepGoing = stopAfterDown(2);
  await runPool(rows, 2, async (row) => {
    const precedents = await findPrecedents(store, row);
    const o = DEFAULT_OPTS;
    const decision = (await callFor(row))?.full ?? null;
    const d = await drafts.get(
      await viewOf(store, row),
      decision,
      precedents,
      o,
    );
    if (d.source === "llm") ok.add(row.dispute_id);
    return keepGoing(d); // gateway down twice in a row: stop instead of waiting out every timeout
  });
  const failed = new Set(
    rows.filter((r) => !ok.has(r.dispute_id)).map((r) => r.dispute_id),
  );
  // up to three retries, 30s apart, of what fell back
  if (failed.size && attempt < 3)
    setTimeout(
      () =>
        void preDraft(failed, attempt + 1).catch((e) =>
          log({ msg: "redraft failed", error: String(e) }),
        ),
      30_000,
    ).unref();
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
      .then(() => preDraft())
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

/** Reseeds the PayPal mock (mock only; a no-op against the sandbox). */
async function resetMock(): Promise<void> {
  if (process.env["PAYPAL_ENV"] !== "mock") return;
  const r = await fetch(`${process.env["PAYPAL_BASE_URL"]}/mock/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`mock reset ${r.status}`);
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
  if (process.env["DEMO_RESET_ON_BOOT"] === "1" && !draining) {
    // reseed before the first sync so the activity panel still shows the sync's PayPal calls
    for (let i = 0; i < 5 && !draining; i++) {
      try {
        await resetMock();
        break;
      } catch (e) {
        log({ msg: "mock reset failed", error: String(e) });
        await sleep(2000);
      }
    }
    try {
      await store.resetWork();
      decisionCache.clear();
      decideDeps.orders.clear();
      drafts.clear();
    } catch (e) {
      log({ msg: "work reset failed", error: String(e) });
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
  // every call is in place before the list can be read; drafting then goes on in the background
  await warmDecisions().catch((e) =>
    log({ msg: "warm failed", error: String(e) }),
  );
  ready = true;
  // a successful sync already started drafting
  if (!syncState.lastOk)
    void preDraft().catch((e) =>
      log({ msg: "predraft failed", error: String(e) }),
    );
}
void boot();
// no webhooks: without this the index keeps what the mock served at the first sync, even after the mock restarts or re-anchors its dates
setInterval(() => {
  if (ready && !syncing && !draining) void runSync().catch(() => undefined);
}, 60_000).unref();

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail: string,
    public extra: Record<string, unknown> = {},
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

/** Validation failures at the trust boundary are 400s. */
function parseAdded(v: unknown): AddedEv[] {
  try {
    return parseAddedEv(v);
  } catch (e) {
    if (e instanceof ValidationError)
      throw new HttpError(400, "bad_request", e.message);
    throw e;
  }
}

/** What the drafting code takes. */
const forDraft = (a: AddedEv[]): Added[] =>
  a.map((x) => ({ item: x.item, note: x.notes }));

/** The label from where the saved text really came from. */
const labelFor = (source: Stored, added: boolean, edited: boolean) =>
  source === "llm"
    ? edited
      ? EDITED_LABEL
      : added
        ? UPDATED_LABEL
        : LABEL_AI
    : source === "grounded"
      ? `${LABEL_GROUNDED(added)}${edited ? ", edited by you" : ""}`
      : edited
        ? "Template, edited by you"
        : LABEL_TEMPLATE;

/** What is saved as a draft's source; "grounded" is a fallback after the model's sentences were all dropped. */
type Stored = "llm" | "fallback" | "grounded";
const storedOf = (d: Draft): Stored =>
  d.source === "llm"
    ? "llm"
    : d.fallback_reason === "grounding"
      ? "grounded"
      : "fallback";
const sourceOf = (s: Stored): "llm" | "fallback" =>
  s === "llm" ? "llm" : "fallback";

// changes on every restart, so an open page can tell that the saved drafts were reset
const BOOT_ID = randomUUID();
const UPDATED_LABEL = "AI draft, updated with your evidence";
const EDITED_LABEL = "AI draft, edited by you";

/** Sentences of the submitted text that are not in the last generated draft: added or changed by the merchant. */
async function addedByMerchant(
  id: string,
  row: CaseRow,
  text: string,
): Promise<string[]> {
  let base = await store.getGenerated(id);
  if (base === null) {
    // never shown: what the desk would write now
    const precedents = await findPrecedents(store, row);
    const o = DEFAULT_OPTS;
    const decision = (await callFor(row))?.full ?? null;
    const work = await store.getWork(id);
    base = (
      await drafts.get(
        await viewOf(store, row),
        decision,
        precedents,
        o,
        forDraft(work?.added ?? []),
      )
    ).response;
    // /check and /evidence must diff against the same base, even if the draft cache lets go of it
    await store.setGenerated(id, base);
  }
  return addedSentences(base, text);
}
function parseVouched(v: unknown): string[] {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    v.length > 10 ||
    v.some((x) => typeof x !== "string" || x.length > 2000)
  )
    throw new HttpError(
      400,
      "bad_request",
      "vouched must be a list of at most 10 sentences of up to 2000 characters",
    );
  return (v as string[]).map((x) => x.trim());
}

async function loadRow(id: string) {
  const row = await store.get(id);
  if (!row)
    throw new HttpError(404, "not_found", `case ${id} is not in the index`);
  return row;
}

const chatDeps = {
  pool,
  llm,
  listCases: async () =>
    (await store.list())
      .filter((r) => waiting(r) || r.status === "WAITING_FOR_BUYER_RESPONSE")
      .map((r) => ({
        id: r.dispute_id,
        buyer: r.buyer,
        item: toView(r).items[0]?.item_description,
        amount_cents: r.amount_cents,
        currency: r.currency,
        call: decisionCache.get(r.dispute_id)?.call ?? null,
        offer_cents: decisionCache.get(r.dispute_id)?.offer_cents ?? null,
        p: decisionCache.get(r.dispute_id)?.p ?? null,
        reason: r.reason,
        due_at: r.due_at,
        due_in_days:
          toView(r).days_left == null ? null : Math.round(toView(r).days_left!),
        // an offer already out: the seller asked "send it" twice
        sent_offer_cents:
          r.status === "WAITING_FOR_BUYER_RESPONSE" &&
          r.raw.offer?.seller_offered_amount
            ? Math.round(Number(r.raw.offer.seller_offered_amount.value) * 100)
            : null,
        status_group: (waiting(r) ? "needs_you" : "waiting") as
          "waiting" | "needs_you",
      })),
  loadCase: async (id: string) => {
    const row = await store.get(id);
    if (!row) return null;
    const d = await callFor(row);
    const work = await store.getWork(id);
    return {
      id,
      buyer: row.buyer,
      amount_cents: row.amount_cents,
      currency: row.currency,
      reason: row.reason,
      item: toView(row).items[0]?.item_description,
      call: d?.call ?? null,
      offer_cents: d?.offer_cents ?? undefined,
      draft_text: work?.draft_text ?? null,
    };
  },
};

async function route(
  req: IncomingMessage,
  url: URL,
): Promise<{ status: number; body: unknown } | "handled"> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const pr = await paypalRoutes(req, url, {
    store,
    paypal,
    HttpError,
    readJson,
    loadRow,
    orders: decideDeps.orders,
  });
  if (pr) return pr;
  const chat = await chatRoutes(req, url, chatDeps);
  if (chat) return chat;
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
        bootId: BOOT_ID,
        paypalEnv: paypal.target.env,
        llm: await llmStatus(),
        cases: await store.count().catch(() => null),
        decide: { url: decideUrl, reachable: await decideReachable() },
        search: "Postgres full-text",
        sync: syncState,
        version: BUILD,
        pod: process.env["POD_NAME"] ?? null,
      },
    };
  if (m === "GET" && p === "/api/openapi.json")
    return { status: 200, body: openapi };
  if (m === "GET" && p === "/api/activity") {
    const events = await activityEvents();
    return {
      status: 200,
      body: asFormat(
        url,
        { events },
        events,
        [
          "time",
          "kind",
          "case",
          "buyer",
          "amount",
          "currency",
          "status",
          "detail",
        ],
        "parley-activity.csv",
      ),
    };
  }
  if (m === "POST" && p === "/api/decide") {
    // the decision core, asked directly: same request shape the desk sends
    const b = await readJson(req);
    try {
      return {
        status: 200,
        body: await callDecide(decideUrl, b as never),
      };
    } catch {
      throw new HttpError(
        502,
        "decide_unavailable",
        "Parley's call did not accept or answer this request",
      );
    }
  }
  if (m === "GET" && p === "/api/paypal-activity")
    return { status: 200, body: { calls: await listCalls(20) } };
  if (m === "POST" && p === "/api/sync") {
    const n = await runSync();
    return { status: 200, body: { synced: n } };
  }
  if (m === "GET" && p === "/api/cases") {
    const rows = await store.list();
    const now = Date.now();
    const open = waiting;
    // the list never answers before the calls are in: wait for a warm in flight, then fill any gap
    await warming?.catch(() => undefined);
    await runPool(
      rows.filter((r) => waiting(r) && !decisionCache.has(r.dispute_id)),
      4,
      async (r) => (await callFor(r), true),
    );
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
    const out = {
      summary: {
        total: views.length,
        needs_response: needs.length,
        under_review: views.filter((v) => v.status === "UNDER_REVIEW").length,
        closed: views.filter((v) => v.status === "RESOLVED").length,
        missed_deadline: views.filter((v) => open(v) && late(v)).length,
        waiting_on_buyer: views.filter(
          (v) => v.status === "WAITING_FOR_BUYER_RESPONSE",
        ).length,
        // anything else (e.g. a status PayPal adds later), so the buckets always add up to total
        other: views.filter(
          (v) =>
            !open(v) &&
            ![
              "UNDER_REVIEW",
              "RESOLVED",
              "WAITING_FOR_BUYER_RESPONSE",
            ].includes(v.status),
        ).length,
        at_stake_cents: needs
          .filter((v) => v.currency === currency)
          .reduce((n, v) => n + v.amount_cents, 0),
        // what Parley expects to keep over the open cases, from the one stored call per case, in whole dollars
        expected_keep_cents: wholeDollarsCents(
          rows
            .filter((r) => waiting(r) && r.currency === currency)
            .reduce(
              (n, r) => n + (decisionCache.get(r.dispute_id)?.keep_cents ?? 0),
              0,
            ),
        ),
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
          items: v.items,
          due_at: v.due_at,
          days_left: v.days_left,
          evidence_on_file: v.evidence_on_file,
          call: d
            ? d.marginal && d.call !== "offer"
              ? `${d.call} (marginal)`
              : d.call
            : null,
          margin_cents: d?.margin_cents ?? null,
          offer_cents: d?.offer_cents ?? null,
          p: d?.p ?? null,
          p_lo: d?.p_lo ?? null,
          p_hi: d?.p_hi ?? null,
          keep_cents: d?.keep_cents ?? null,
        };
      }),
    };
    return {
      status: 200,
      body: asFormat(
        url,
        out,
        out.cases,
        [
          "dispute_id",
          "buyer",
          "reason",
          "status",
          "amount_cents",
          "currency",
          "due_at",
          "call",
          "offer_cents",
          "margin_cents",
        ],
        "parley-disputes.csv",
      ),
    };
  }
  if (m === "GET" && p === "/api/assumptions")
    return { status: 200, body: await callAssumptions(decideUrl) };
  const rec = /^\/api\/cases\/([^/]+)\/decision$/.exec(p);
  if (m === "GET" && rec) {
    const row = await loadRow(decodeURIComponent(rec[1]!));
    const precedents = await findPrecedents(store, row);
    const request = await requestFor(decideDeps, row, precedents, DEFAULT_OPTS);
    const response = waiting(row)
      ? ((await callFor(row))?.full ?? null)
      : await decideFor(decideDeps, row, precedents, DEFAULT_OPTS);
    return {
      status: 200,
      body: {
        case: row.dispute_id,
        request,
        response,
        core: { contract: request.contract, version: BUILD },
        ...(response ? {} : { degraded: true }),
      },
    };
  }
  const one = /^\/api\/cases\/([^/]+)$/.exec(p);
  if (m === "GET" && one) {
    const row = await loadRow(decodeURIComponent(one[1]!));
    const precedents = await findPrecedents(store, row);
    const decision = waiting(row)
      ? ((await callFor(row))?.full ?? null)
      : await decideFor(decideDeps, row, precedents, DEFAULT_OPTS);
    return {
      status: 200,
      body: {
        case: await viewOf(store, row),
        precedents,
        decision,
        ...(decision ? {} : { degraded: true }),
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
  if (m === "POST" && p === "/api/demo/reset") {
    const b = await readJson(req);
    if (b["confirm"] !== true)
      throw new HttpError(
        400,
        "confirmation_required",
        "send confirm: true to clear saved work",
      );
    // the mock too, so sent evidence and accepted claims come back for the next run of the demo
    await resetMock();
    await store.resetWork();
    decisionCache.clear();
    decideDeps.orders.clear();
    drafts.clear();
    await runSync();
    return { status: 200, body: { reset: true } };
  }
  const a =
    /^\/api\/cases\/([^/]+)\/(analysis|evidence|accept|draft|work|check)$/.exec(
      p,
    );
  if (a) {
    const id = decodeURIComponent(a[1]!);
    if (m === "GET" && a[2] === "analysis") {
      const row = await loadRow(id);
      const prior = num(url.searchParams.get("prior"));
      const c = dollarsToCents(url.searchParams.get("c"));
      const fee = dollarsToCents(url.searchParams.get("fee"));
      const work = await store.getWork(id);
      const sent = await store.getSent(id);
      const whatIf =
        prior !== undefined || c !== undefined || fee !== undefined;
      const out = await analyse(
        {
          store,
          llm,
          decideUrl,
          orders: decideDeps.orders,
          // the default view reads the stored call; a what-if computes its own and never stores it
          ...(whatIf || !waiting(row)
            ? {}
            : {
                decide: async (r: CaseRow) => (await callFor(r))?.full ?? null,
              }),
          // a slow gateway answers the page with the call first: the draft keeps going and joins the next read
          draft: async (v, dc, pr, o, ad) => {
            const d = drafts.get(v, dc, pr, o, ad);
            const quick = await Promise.race([d, sleep(4000).then(() => null)]);
            d.catch(() => undefined);
            if (quick) return quick;
            const fb = fallbackDraft(withAdded(v, ad), dc, o.handlingCostCents);
            return {
              ...fb,
              checklist: markAdded(fb.checklist, ad),
              source: "fallback" as const,
              fallback_reason: "ai_down" as const,
              label: LABEL_TEMPLATE,
            };
          },
        },
        row,
        {
          prior: prior ?? null,
          handlingCostCents: c ?? DEFAULT_HANDLING_CENTS,
          feeIfLostCents: fee ?? 0,
        },
        forDraft(evidenceOnFile(work, sent)),
      );
      const hasAdded = (work?.added.length ?? 0) > 0;
      // the merchant's edits are diffed against the last draft the desk wrote
      if (!work?.draft_text) await store.setGenerated(id, out.draft.response);
      else if ((await store.getGenerated(id)) === null)
        await store.setGenerated(id, work.draft_text);
      if (work?.draft_text) {
        // saved text keeps the source it really came from (older rows: read it off the label)
        const source: Stored =
          work.draft_source ??
          (work.draft_label?.match(/^(AI|Written by)/) ? "llm" : "fallback");
        out.draft = {
          ...out.draft,
          response: work.draft_text,
          source: sourceOf(source),
          label: labelFor(source, hasAdded, work.edited),
        };
      } else {
        out.draft = {
          ...out.draft,
          label: labelFor(storedOf(out.draft), hasAdded, false),
        };
      }
      // a slow gateway call must not leave the fallback as final: try the model once more in the background
      let drafting = false;
      if (
        !work?.draft_text &&
        out.draft.fallback_reason === "ai_down" &&
        out.decision &&
        (await llmOnline())
      ) {
        drafting = true;
        void drafts
          .get(
            out.case,
            out.decision,
            out.precedents,
            {
              prior: prior ?? null,
              handlingCostCents: c ?? DEFAULT_HANDLING_CENTS,
              feeIfLostCents: fee ?? 0,
            },
            forDraft(work?.added ?? []),
          )
          .catch(() => undefined);
      }
      return { status: 200, body: { ...out, work, sent, drafting } };
    }
    if (m === "PUT" && a[2] === "work") {
      await loadRow(id);
      const b = await readJson(req);
      const added =
        b["added"] === undefined ? undefined : parseAdded(b["added"]);
      const text = b["text"];
      if (
        text !== undefined &&
        (typeof text !== "string" || text.length > 8000)
      )
        throw new HttpError(
          400,
          "bad_request",
          "text must be a string of at most 8000 characters",
        );
      if (b["edited"] !== undefined && typeof b["edited"] !== "boolean")
        throw new HttpError(400, "bad_request", "edited must be true or false");
      const old = await store.getWork(id);
      const edited = b["edited"] as boolean | undefined;
      // without a saved source, take the page's word, else what the last real draft was
      const source: Stored =
        old?.draft_source ??
        (b["source"] === "llm" ||
        b["source"] === "fallback" ||
        b["source"] === "grounded"
          ? b["source"]
          : (drafts.lastSource.get(id) ??
            (drafts.lastOk === false ? "fallback" : "llm")));
      // new evidence makes the saved text older than the evidence: its label no longer claims otherwise
      const addedChanged =
        added !== undefined &&
        JSON.stringify(added) !== JSON.stringify(old?.added ?? []);
      const label =
        text !== undefined && edited !== false
          ? labelFor(source, (added ?? old?.added ?? []).length > 0, true)
          : addedChanged && text === undefined
            ? null
            : undefined;
      const work = await store.putWork(id, {
        ...(added ? { added } : {}),
        ...(text !== undefined ? { text, source } : {}),
        ...(label !== undefined ? { label } : {}),
        edited: text !== undefined ? (edited ?? true) : edited,
      });
      return { status: 200, body: { work } };
    }
    if (m === "POST" && a[2] === "draft") {
      // writes nothing to PayPal, so no confirm
      const b = await readJson(req);
      const added = parseAdded(b["added"]);
      const row = await loadRow(id);
      const precedents = await findPrecedents(store, row);
      const o = DEFAULT_OPTS;
      const decision = (await callFor(row))?.full ?? null;
      const draft = await drafts.get(
        await viewOf(store, row),
        decision,
        precedents,
        o,
        forDraft(added),
      );
      const label = labelFor(storedOf(draft), added.length > 0, false);
      await store.setGenerated(id, draft.response);
      await store.putWork(id, {
        added,
        text: draft.response,
        label,
        source: storedOf(draft),
        edited: false,
      });
      return { status: 200, body: { draft: { ...draft, label } } };
    }
    if (m === "POST" && a[2] === "check") {
      // dry run: writes nothing and needs no confirm
      const b = await readJson(req);
      if (typeof b["text"] !== "string" || b["text"].length > 8000)
        throw new HttpError(
          400,
          "bad_request",
          "text must be a string of at most 8000 characters",
        );
      const row0 = await loadRow(id);
      const ev =
        b["evidence"] === undefined
          ? ((await store.getWork(id))?.added ?? [])
          : parseAdded(b["evidence"]);
      const vouched = parseVouched(b["vouched"]);
      const { unsupported } = gateEvidence(
        b["text"],
        proofText(toView(row0), ev),
        vouched,
      );
      const sentences = claimsOf(
        unsupported,
        await addedByMerchant(id, row0, b["text"]),
        parseVouched(b["attested"]),
      );
      return { status: 200, body: { sentences } };
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
      const row0 = await loadRow(id);
      let row;
      if (a[2] === "evidence") {
        const text = typeof b["text"] === "string" ? b["text"].trim() : "";
        if (!text) throw new HttpError(400, "bad_request", "text is required");
        const work = await store.getWork(id);
        // the page's evidence, else what was saved for the case
        const ev =
          b["evidence"] === undefined
            ? (work?.added ?? [])
            : parseAdded(b["evidence"]);
        let extra;
        try {
          extra = parseExtra({ ...b, evidence: ev });
        } catch (e) {
          if (e instanceof ValidationError)
            throw new HttpError(400, "bad_request", e.message);
          throw e;
        }
        const attested = parseVouched(b["attested"]);
        const vouched = [...parseVouched(b["vouched"]), ...attested];
        const { unsupported, held } = gateEvidence(
          text,
          proofText(toView(row0), ev),
          vouched,
        );
        const sentences = claimsOf(
          unsupported,
          await addedByMerchant(id, row0, text),
          attested,
        );
        if (sentences.length)
          throw new HttpError(
            422,
            "unsupported_claim",
            "Some sentences are claims with no evidence on file.",
            { sentences },
          );
        // the text goes out as written; each vouched sentence is its own evidence entry
        const statements: AddedEv[] = held.map((x) => ({
          item: "Your statement",
          evidence_type: "OTHER",
          notes: `${attested.includes(x) ? "Merchant attests" : "Merchant statement"}: ${x}`,
        }));
        const sentEv = [...(extra?.evidence ?? []), ...statements];
        try {
          row = await submitEvidence(paypal, store, id, text, {
            evidence: sentEv,
            files: extra?.files ?? [],
          });
        } catch (e) {
          if (e instanceof PayPalApiError)
            throw new HttpError(502, "paypal_rejected", e.message);
          throw e;
        }
        await store.recordSent(id, text, sentEv, held);
        await store.deleteWork(id);
        approved(id, "Send to PayPal");
      } else {
        const note =
          typeof b["note"] === "string" && b["note"].trim()
            ? b["note"].trim()
            : "Accepted by the seller from the desk";
        row = await acceptClaim(paypal, store, id, note);
        await store.deleteWork(id);
        approved(id, "Accept the claim");
      }
      decisionCache.drop(id);
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
  if (body instanceof Raw) {
    res.writeHead(status, {
      "content-type": body.type,
      ...(body.file
        ? { "content-disposition": `attachment; filename="${body.file}"` }
        : {}),
    });
    res.end(body.text);
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const demoLimits = process.env["DEMO_LIMITS"] === "1" ? createDemoLimits() : null;

const server = createServer((req, res) => {
  void (async () => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    let status = 200;
    try {
      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/console")
      ) {
        // the landing page at /, the desk itself at /console
        const page = url.pathname === "/" ? "welcome.html" : "index.html";
        if (!serveFile(res, join(publicDir, page)))
          send(res, 404, { error: "not_found", detail: "page missing" });
        return;
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/app.js" ||
          url.pathname === "/app.css" ||
          url.pathname === "/owl.js")
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
      if (url.pathname.startsWith("/api/")) {
        if (!demoLimits && url.pathname === "/api/demo/session") {
          send(res, 200, { enabled: false });
          return;
        }
        const v = demoLimits?.check(req, url.pathname, clientIp(req));
        if (v && !v.ok) throw new HttpError(v.status, v.code, v.detail, v.extra);
        if (v?.setCookie) res.setHeader("set-cookie", v.setCookie);
        if (v?.body) {
          send(res, 200, v.body);
          return;
        }
      }
      const r = await route(req, url);
      if (r === "handled") return;
      status = r.status;
      send(res, r.status, r.body);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        send(res, status, { ...e.extra, error: e.code, detail: e.message });
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
