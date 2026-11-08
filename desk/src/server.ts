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
  toView,
  viewOf,
} from "./analysis.js";
import { DEFAULT_HANDLING_CENTS } from "./decide-client.js";
import { PgStore } from "./db.js";
import { gateEvidence } from "./factcheck.js";
import type { Added, CaseRow } from "./types.js";
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

// online = the last real completion worked, or a fresh probe of the gateway answered.
// A failed draft only forces a new probe; it never turns the badge off by itself.
let probe = { at: 0, ok: false };
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

async function llmStatus() {
  const online = await llmOnline();
  return { online, label: online ? `AI (${llm.model})` : "offline fallback" };
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

/** Decision at the default options for one waiting case, cached for the grid's Call column. */
async function ensureDecision(row: CaseRow): Promise<boolean> {
  if (decisionCache.has(row.dispute_id)) return true;
  const d = await decideFor(
    { decideUrl },
    row,
    await findPrecedents(store, row),
    {},
  );
  if (!d) return false;
  decisionCache.set(row.dispute_id, {
    call: d.call,
    margin_cents: d.margin_cents,
    marginal: d.marginal,
  });
  return true;
}

let warming: Promise<void> | null = null;
// retries every 5 s for up to 3 min until every waiting case has a decision
function warmDecisions(): Promise<void> {
  return (warming ??= (async () => {
    const until = Date.now() + 180_000;
    for (;;) {
      const rows = (await store.list()).filter(
        (r) => waiting(r) && !decisionCache.has(r.dispute_id),
      );
      if (!rows.length || Date.now() > until) return;
      await runPool(rows, 4, async (r) => (await ensureDecision(r), true));
      if (rows.some((r) => !decisionCache.has(r.dispute_id))) await sleep(5000);
    }
  })().finally(() => {
    warming = null;
  }));
}

// draft the open cases nobody has opened yet, headline cases first, two at a time
async function preDraft(only?: Set<string>): Promise<void> {
  const rows = (await store.list())
    .filter((r) => waiting(r) && (!only || only.has(r.dispute_id)))
    .sort((a, b) => rank(a.dispute_id) - rank(b.dispute_id)); // stable: due-date order within a rank
  const ok = new Set<string>();
  await runPool(rows, 2, async (row) => {
    const precedents = await findPrecedents(store, row);
    const o = {
      prior: null,
      handlingCostCents: DEFAULT_HANDLING_CENTS,
      feeIfLostCents: 0,
    };
    const decision = await decideFor({ decideUrl }, row, precedents, o);
    const d = await drafts.get(
      await viewOf(store, row),
      decision,
      precedents,
      o,
    );
    if (d.source === "llm") ok.add(row.dispute_id);
    return d.source === "llm"; // gateway down: stop instead of waiting out every timeout
  });
  const failed = new Set(
    rows.filter((r) => !ok.has(r.dispute_id)).map((r) => r.dispute_id),
  );
  // one retry of what fell back
  if (failed.size && !only)
    setTimeout(
      () =>
        void preDraft(failed).catch((e) =>
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
  // pre-drafting starts at startup even when the first syncs failed and the index is from before
  if (!syncState.lastOk)
    void warmDecisions()
      .then(() => preDraft())
      .catch((e) => log({ msg: "warm failed", error: String(e) }));
}
void boot();

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

function parseAdded(v: unknown): Added[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10)
    throw new HttpError(
      400,
      "bad_request",
      "added must be a list of at most 10 entries",
    );
  return v.map((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    if (
      typeof e["item"] !== "string" ||
      typeof e["note"] !== "string" ||
      !e["item"].trim() ||
      !e["note"].trim() ||
      e["item"].length > 120 ||
      e["note"].length > 2000
    )
      throw new HttpError(
        400,
        "bad_request",
        "each added entry needs an item (up to 120 characters) and a note (up to 2000)",
      );
    return { item: e["item"].trim(), note: e["note"].trim() };
  });
}

const UPDATED_LABEL = "AI draft, updated with your evidence";
const EDITED_LABEL = "AI draft, edited by you";

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

const MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
/** Everything a sentence of the response may rest on: what is on file, the merchant's added notes, and this send's own evidence. */
function proofText(
  view: ReturnType<typeof toView>,
  added: Added[],
  extra?: {
    evidence: {
      notes: string;
      tracking?: { carrier: string; number: string };
    }[];
  },
): string {
  const lines: string[] = view.items.map(
    (i) => `${i.item_quantity} ${i.item_description}`,
  );
  if (view.purchased_at) {
    const dt = new Date(view.purchased_at);
    lines.push(
      `purchased ${view.purchased_at.slice(0, 10)} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`,
    );
  }
  for (const e of view.evidences) {
    lines.push(e.notes ?? "");
    for (const t of e.evidence_info?.tracking_info ?? [])
      lines.push(`${t.carrier_name ?? ""} ${t.tracking_number ?? ""}`);
  }
  for (const a of added) lines.push(`${a.item}: ${a.note}`);
  for (const e of extra?.evidence ?? [])
    lines.push(
      e.notes,
      e.tracking ? `${e.tracking.carrier} ${e.tracking.number}` : "",
    );
  return lines.join("\n");
}

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
        llm: await llmStatus(),
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
    const open = waiting;
    // never leave a waiting case without a call while decide is reachable
    await runPool(
      rows.filter((r) => waiting(r) && !decisionCache.has(r.dispute_id)),
      4,
      async (r) => (await ensureDecision(r), true),
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
    return {
      status: 200,
      body: {
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
  if (m === "POST" && p === "/api/demo/reset") {
    const b = await readJson(req);
    if (b["confirm"] !== true)
      throw new HttpError(
        400,
        "confirmation_required",
        "send confirm: true to clear saved work",
      );
    await store.resetWork();
    decisionCache.clear();
    return { status: 200, body: { reset: true } };
  }
  const a =
    /^\/api\/cases\/([^/]+)\/(analysis|evidence|accept|draft|work)$/.exec(p);
  if (a) {
    const id = decodeURIComponent(a[1]!);
    if (m === "GET" && a[2] === "analysis") {
      const row = await loadRow(id);
      const prior = num(url.searchParams.get("prior"));
      const c = dollarsToCents(url.searchParams.get("c"));
      const fee = dollarsToCents(url.searchParams.get("fee"));
      const work = await store.getWork(id);
      const sent = await store.getSent(id);
      const out = await analyse(
        {
          store,
          llm,
          decideUrl,
          draft: (v, dc, pr, o, ad) => drafts.get(v, dc, pr, o, ad),
        },
        row,
        {
          prior: prior ?? null,
          handlingCostCents: c ?? DEFAULT_HANDLING_CENTS,
          feeIfLostCents: fee ?? 0,
        },
        work?.added ?? [],
      );
      if (work?.draft_text) {
        out.draft = {
          ...out.draft,
          response: work.draft_text,
          ...(work.draft_label ? { label: work.draft_label } : {}),
        };
      } else if (work?.added.length && out.draft.source === "llm") {
        out.draft = { ...out.draft, label: UPDATED_LABEL };
      }
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
      return { status: 200, body: { ...out, work, sent } };
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
      // new evidence makes the saved text older than the evidence: its label no longer claims otherwise
      const addedChanged =
        added !== undefined &&
        JSON.stringify(added) !== JSON.stringify(old?.added ?? []);
      const label =
        text !== undefined && edited !== false
          ? EDITED_LABEL
          : addedChanged && text === undefined
            ? null
            : undefined;
      const work = await store.putWork(id, {
        ...(added ? { added } : {}),
        ...(text !== undefined ? { text } : {}),
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
      const o = {
        prior: null,
        handlingCostCents: DEFAULT_HANDLING_CENTS,
        feeIfLostCents: 0,
      };
      const decision = await decideFor({ decideUrl }, row, precedents, o);
      const draft = await drafts.get(
        await viewOf(store, row),
        decision,
        precedents,
        o,
        added,
      );
      const label = added.length ? UPDATED_LABEL : "AI draft";
      await store.putWork(id, {
        added,
        text: draft.response,
        label,
        edited: false,
      });
      return { status: 200, body: { draft: { ...draft, label } } };
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
        let extra;
        try {
          extra = parseExtra(b);
        } catch (e) {
          if (e instanceof ValidationError)
            throw new HttpError(400, "bad_request", e.message);
          throw e;
        }
        const vouched = parseVouched(b["vouched"]);
        const work = await store.getWork(id);
        const proof = proofText(toView(row0), work?.added ?? [], extra);
        const { unsupported, held, sentText } = gateEvidence(
          text,
          proof,
          vouched,
        );
        if (unsupported.length)
          throw new HttpError(
            422,
            "unsupported_claim",
            "Some sentences mention evidence that is not on file.",
            { sentences: unsupported },
          );
        row = await submitEvidence(paypal, store, id, sentText, extra);
        await store.recordSent(id, sentText, work?.added ?? [], held);
        await store.deleteWork(id);
      } else {
        const note =
          typeof b["note"] === "string" && b["note"].trim()
            ? b["note"].trim()
            : "Accepted by the seller from the desk";
        row = await acceptClaim(paypal, store, id, note);
        await store.deleteWork(id);
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
