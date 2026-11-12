import type { IncomingMessage } from "node:http";
import { PayPalApiError, type PayPalClient } from "@jeirslab/paypal-client";
import { record } from "./activity.js";
import type { PgStore } from "./db.js";
import { refreshCase } from "./sync.js";
import { toView } from "./analysis.js";
import type { CaseRow } from "./types.js";

type Result = { status: number; body: unknown };
type ErrCtor = new (
  status: number,
  code: string,
  detail: string,
  extra?: Record<string, unknown>,
) => Error;

export interface Deps {
  store: Pick<PgStore, "byBuyer" | "upsert" | "retainOnly">;
  paypal: PayPalClient;
  HttpError: ErrCtor;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  loadRow: (id: string) => Promise<CaseRow>;
}

const D = "/v1/customer/disputes";
const OFFER_TYPES = [
  "REFUND",
  "REFUND_WITH_RETURN",
  "REFUND_WITH_REPLACEMENT",
] as const;
export const WEBHOOK_EVENTS = [
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
];
const MAX_WEBHOOK = 64 * 1024;

/** First letter, three dots, the domain: the full address never leaves the server. */
export function maskEmail(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at < 1) return null;
  return `${email[0]}•••@${email.slice(at + 1)}`;
}

/** Checks the offer body against the case. Returns the error code and detail, or the cleaned offer. */
export function checkOffer(
  b: Record<string, unknown>,
  caseCents: number,
): { error: [string, string] } | { cents: number; type: string; note: string } {
  if (b["confirm"] !== true)
    return {
      error: ["confirmation_required", "send confirm: true to write to PayPal"],
    };
  const c = b["amount_cents"];
  if (typeof c !== "number" || !Number.isInteger(c) || c <= 0 || c >= caseCents)
    return {
      error: [
        "bad_request",
        "amount_cents must be a whole number of cents above 0 and below the case amount",
      ],
    };
  const type = b["offer_type"] ?? "REFUND";
  if (
    typeof type !== "string" ||
    !(OFFER_TYPES as readonly string[]).includes(type)
  )
    return {
      error: [
        "bad_request",
        `offer_type must be one of ${OFFER_TYPES.join(", ")}`,
      ],
    };
  const n = b["note"];
  if (n !== undefined && (typeof n !== "string" || n.length > 2000))
    return {
      error: ["bad_request", "note must be text of at most 2000 characters"],
    };
  return {
    cents: c,
    type,
    note:
      (typeof n === "string" && n.trim()) ||
      "Partial refund offered from the desk",
  };
}

/** The dispute id a webhook event is about, or null for an event type we do not act on. */
export function webhookDispute(ev: unknown): string | null {
  const e = ev as { event_type?: unknown; resource?: { dispute_id?: unknown } };
  const id = e?.resource?.dispute_id;
  return typeof e?.event_type === "string" &&
    WEBHOOK_EVENTS.includes(e.event_type) &&
    typeof id === "string" &&
    id
    ? id
    : null;
}

async function readRaw(req: IncomingMessage, E: ErrCtor): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_WEBHOOK)
      throw new E(413, "too_large", "request body is too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function verifyWebhook(
  req: IncomingMessage,
  event: unknown,
  { paypal, HttpError }: Deps,
): Promise<true | "mock"> {
  if (paypal.target.env !== "sandbox" && paypal.target.env !== "live")
    return "mock";
  const webhookId = process.env["PAYPAL_WEBHOOK_ID"];
  const h = (k: string) => String(req.headers[k] ?? "");
  const refuse = () =>
    new HttpError(
      400,
      "signature_refused",
      "the webhook signature was not accepted",
    );
  if (!webhookId || !h("paypal-transmission-sig")) throw refuse();
  const r = await fetch(
    `${paypal.target.baseUrl}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await paypal.getAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const v = (await r.json().catch(() => ({}))) as {
    verification_status?: string;
  };
  if (!r.ok || v.verification_status !== "SUCCESS") throw refuse();
  return true;
}

async function offer(
  req: IncomingMessage,
  id: string,
  deps: Deps,
): Promise<Result> {
  const { paypal, HttpError } = deps;
  const b = await deps.readJson(req);
  // confirm is checked before the case is looked up, like /evidence and /accept
  if (b["confirm"] !== true)
    throw new HttpError(
      400,
      "confirmation_required",
      "send confirm: true to write to PayPal",
    );
  const row0 = await deps.loadRow(id);
  const ck = checkOffer(b, row0.amount_cents);
  if ("error" in ck) throw new HttpError(400, ck.error[0], ck.error[1]);
  const live = await paypal.disputes.get(id);
  if (!live.links?.some((l) => l.rel === "make_offer"))
    throw new HttpError(
      409,
      "offer_not_allowed",
      "PayPal does not accept an offer on this case right now",
    );
  const t = Date.now();
  let status = 200;
  try {
    await paypal.disputes.makeOffer(id, {
      note: ck.note,
      offer_amount: {
        currency_code: row0.currency,
        value: (ck.cents / 100).toFixed(2),
      },
      offer_type: ck.type as (typeof OFFER_TYPES)[number],
    });
  } catch (e) {
    status = e instanceof PayPalApiError ? e.status : 0;
    if (e instanceof PayPalApiError)
      throw new HttpError(502, "paypal_rejected", e.message);
    throw e;
  } finally {
    record({
      method: "POST",
      path: `${D}/${id}/make-offer`,
      status,
      ms: Date.now() - t,
    });
  }
  const row = await refreshCase(paypal, deps.store, id);
  return { status: 200, body: { case: toView(row) } };
}

async function buyer(id: string, deps: Deps): Promise<Result> {
  const { paypal, store } = deps;
  const row = await deps.loadRow(id);
  const tx = row.raw.disputed_transactions?.[0];
  const others = await store.byBuyer(row.buyer, id);
  const all = [row, ...others];
  const firsts = all
    .map((r) => r.raw.disputed_transactions?.[0]?.create_time)
    .filter((x): x is string => !!x)
    .sort();
  let info:
    | Awaited<
        ReturnType<PayPalClient["transactions"]["search"]>
      >["transaction_details"][number]
    | undefined;
  if (tx) {
    const at = Date.parse(tx.create_time);
    try {
      const r = await paypal.transactions.search({
        start_date: new Date(at - 86_400_000).toISOString(),
        end_date: new Date(at + 86_400_000).toISOString(),
        transaction_id: tx.seller_transaction_id,
      });
      info = r.transaction_details[0];
    } catch {
      /* the card still shows what the case itself knows */
    }
  }
  const p = info?.payer_info;
  const addr = info?.shipping_info?.address;
  return {
    status: 200,
    body: {
      name: row.buyer,
      payer_id: p?.account_id ?? null,
      email_masked: maskEmail(p?.email_address),
      account_status: p?.account_status ?? null,
      country: p?.country_code ?? addr?.country_code ?? null,
      ship_to: addr ? { city: addr.city, state: addr.state ?? null } : null,
      orders_with_you: all.length,
      disputes_with_you: all.length,
      first_order_at: firsts[0] ?? null,
      address_matches_delivery:
        p?.country_code && addr?.country_code
          ? p.country_code === addr.country_code
          : null,
      source: paypal.target.env === "mock" ? "mock" : "sandbox",
    },
  };
}

async function webhook(req: IncomingMessage, deps: Deps): Promise<Result> {
  const { HttpError } = deps;
  const raw = await readRaw(req, HttpError);
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_request", "body is not valid JSON");
  }
  const verified = await verifyWebhook(req, event, deps);
  const id = webhookDispute(event);
  if (!id) return { status: 200, body: { verified, ignored: true } };
  const t = Date.now();
  let synced = true;
  try {
    await refreshCase(deps.paypal, deps.store, id);
  } catch {
    synced = false;
  }
  const type = (event as { event_type: string }).event_type;
  record({
    method: "WEBHOOK",
    path: `${D}/${id}#${type}`,
    status: synced ? 200 : 502,
    ms: Date.now() - t,
    kind: "webhook",
  });
  return { status: 200, body: { verified, dispute_id: id, synced } };
}

/** Routes that talk to PayPal: make-offer, the buyer card, the webhook receiver. Null when the path is not ours. */
export async function paypalRoutes(
  req: IncomingMessage,
  url: URL,
  deps: Deps,
): Promise<Result | null> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  if (m === "POST" && p === "/api/webhooks/paypal") return webhook(req, deps);
  const c = /^\/api\/cases\/([^/]+)\/(offer|buyer)$/.exec(p);
  if (!c) return null;
  const id = decodeURIComponent(c[1]!);
  if (m === "POST" && c[2] === "offer") return offer(req, id, deps);
  if (m === "GET" && c[2] === "buyer") return buyer(id, deps);
  return null;
}
