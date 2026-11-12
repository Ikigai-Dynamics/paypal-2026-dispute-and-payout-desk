import type {
  Dispute,
  DisputeStatus,
  DisputeSummary,
  Evidence,
} from "@jeirslab/paypal-client/types";
import {
  invalid,
  notFound,
  route,
  unprocessable,
  type Ctx,
  type Route,
} from "../http.js";
import { money, toCents } from "../money.js";
import {
  DISPUTE_REASONS,
  DISPUTE_STAGES,
  DISPUTE_STATE,
  liveId,
} from "../state.js";

const DAY = 86_400_000;

function summary(ctx: Ctx, d: Dispute): DisputeSummary {
  const {
    dispute_id,
    create_time,
    update_time,
    reason,
    status,
    dispute_amount,
    dispute_life_cycle_stage,
    dispute_channel,
    outcome,
  } = d;
  return {
    dispute_id,
    create_time,
    update_time,
    reason,
    status,
    dispute_state: DISPUTE_STATE[status],
    dispute_amount,
    dispute_life_cycle_stage,
    dispute_channel,
    ...(outcome ? { outcome } : {}),
    links: [
      {
        href: `http://${ctx.host}/v1/customer/disputes/${dispute_id}`,
        rel: "self",
        method: "GET",
      },
    ],
  };
}

function full(ctx: Ctx, d: Dispute): Dispute {
  const base = `http://${ctx.host}/v1/customer/disputes/${d.dispute_id}`;
  const links = [{ href: base, rel: "self", method: "GET" }];
  if (d.status === "WAITING_FOR_SELLER_RESPONSE") {
    links.push({
      href: `${base}/provide-evidence`,
      rel: "provide_evidence",
      method: "POST",
    });
    links.push({
      href: `${base}/accept-claim`,
      rel: "accept_claim",
      method: "POST",
    });
    links.push({
      href: `${base}/make-offer`,
      rel: "make_offer",
      method: "POST",
    });
  }
  return { ...d, dispute_state: DISPUTE_STATE[d.status], links };
}

function get(ctx: Ctx): Dispute {
  const d = ctx.state.disputes.get(ctx.params["id"]!);
  if (!d) throw notFound("Dispute", ctx.params["id"]!);
  return d;
}

interface Part {
  name: string;
  filename?: string;
  contentType: string;
  size: number;
  text: string;
}

/** Minimal multipart/form-data reader. Files are only measured, never stored. */
function parseMultipart(ctx: Ctx): Part[] {
  const ct = String(ctx.headers["content-type"] ?? "");
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!m)
    throw invalid("INVALID_PARAMETER_VALUE", "multipart boundary missing");
  const boundary = `--${m[1] ?? m[2]}`;
  const raw = ctx.raw.toString("latin1");
  const parts: Part[] = [];
  for (const chunk of raw.split(boundary).slice(1)) {
    if (chunk.startsWith("--")) break;
    const body = chunk.replace(/^\r\n/, "");
    const sep = body.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const head = body.slice(0, sep);
    const content = body.slice(sep + 4).replace(/\r\n$/, "");
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const type =
      /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "text/plain";
    parts.push({
      name,
      ...(filename !== undefined ? { filename } : {}),
      contentType: type,
      size: content.length,
      text: Buffer.from(content, "latin1").toString("utf8"),
    });
  }
  return parts;
}

const touch = (d: Dispute) => {
  d.update_time = new Date().toISOString();
};

export const disputeRoutes: Route[] = [
  route("GET", "/v1/customer/disputes", (ctx) => {
    const q = ctx.url.searchParams;
    const size = Math.min(
      50,
      Math.max(1, Number(q.get("page_size") ?? 10) || 10),
    );
    const offset = Math.max(0, Number(q.get("next_page_token") ?? 0) || 0);
    const states = q.get("dispute_state")?.split(",");
    const start = q.get("start_time")
      ? Date.parse(q.get("start_time")!.replace(" ", "+"))
      : undefined;
    const upd = q.get("update_time_after")
      ? Date.parse(q.get("update_time_after")!.replace(" ", "+"))
      : undefined;
    const tx = q.get("disputed_transaction_id");
    const all = [...ctx.state.disputes.values()]
      .filter((d) => !states || states.includes(DISPUTE_STATE[d.status]))
      .filter((d) => start === undefined || Date.parse(d.create_time) >= start)
      .filter((d) => upd === undefined || Date.parse(d.update_time) > upd)
      .filter(
        (d) =>
          !tx ||
          d.disputed_transactions.some((t) => t.seller_transaction_id === tx),
      )
      .sort(
        (a, b) =>
          b.create_time.localeCompare(a.create_time) ||
          a.dispute_id.localeCompare(b.dispute_id),
      );
    const items = all.slice(offset, offset + size).map((d) => summary(ctx, d));
    const base = `http://${ctx.host}/v1/customer/disputes`;
    const links = [
      { href: `${base}?page_size=${size}`, rel: "self", method: "GET" },
    ];
    if (offset + size < all.length)
      links.push({
        href: `${base}?page_size=${size}&next_page_token=${offset + size}`,
        rel: "next",
        method: "GET",
      });
    return { status: 200, body: { items, links } };
  }),

  route("GET", "/v1/customer/disputes/:id", (ctx) => ({
    status: 200,
    body: full(ctx, get(ctx)),
  })),

  route("POST", "/v1/customer/disputes/:id/provide-evidence", (ctx) => {
    const d = get(ctx);
    let evidences: Evidence[];
    const files: { name: string; contentType: string; size: number }[] = [];
    const ct = String(ctx.headers["content-type"] ?? "");
    if (ct.startsWith("multipart/form-data")) {
      const parts = parseMultipart(ctx);
      const input = parts.find((p) => p.name === "input");
      if (!input)
        throw invalid(
          "MISSING_REQUIRED_PARAMETER",
          "multipart part 'input' is required",
          "/input",
        );
      try {
        evidences = (JSON.parse(input.text) as { evidences: Evidence[] })
          .evidences;
      } catch {
        throw invalid(
          "MALFORMED_REQUEST_JSON",
          "part 'input' is not valid JSON",
        );
      }
      for (const p of parts)
        if (p.filename !== undefined)
          files.push({
            name: p.filename,
            contentType: p.contentType,
            size: p.size,
          });
    } else {
      evidences = ctx.json<{ evidences: Evidence[] }>().evidences;
    }
    if (!Array.isArray(evidences) || evidences.length === 0)
      throw invalid(
        "MISSING_REQUIRED_PARAMETER",
        "evidences is required",
        "/evidences",
      );
    if (d.status !== "WAITING_FOR_SELLER_RESPONSE")
      throw unprocessable(
        "NOT_ALLOWED",
        "Evidence can only be provided while waiting for the seller",
      ); // unverified
    d.evidences.push(...evidences.map((e) => ({ ...e, files })));
    d.status = "UNDER_REVIEW";
    delete d.seller_response_due_date;
    d.messages.push({
      posted_by: "SELLER",
      time_posted: new Date().toISOString(),
      content: evidences.map((e) => e.notes ?? e.evidence_type).join("; "),
    });
    touch(d);
    return {
      status: 200,
      body: {
        links: [
          {
            href: `http://${ctx.host}/v1/customer/disputes/${d.dispute_id}`,
            rel: "self",
            method: "GET",
          },
        ],
      },
    };
  }),

  route("POST", "/v1/customer/disputes/:id/make-offer", (ctx) => {
    const d = get(ctx);
    const b = ctx.json<{
      note?: string;
      offer_amount?: { currency_code: string; value: string };
      offer_type?: string;
    }>();
    if (!b?.note)
      throw invalid("MISSING_REQUIRED_PARAMETER", "note is required", "/note");
    const a = b.offer_amount;
    if (!a?.value || !a.currency_code)
      throw invalid(
        "MISSING_REQUIRED_PARAMETER",
        "offer_amount is required",
        "/offer_amount",
      );
    const type = b.offer_type ?? "REFUND";
    if (
      ![
        "REFUND",
        "REFUND_WITH_RETURN",
        "REFUND_WITH_REPLACEMENT",
        "REPLACEMENT_WITHOUT_REFUND",
      ].includes(type)
    )
      throw invalid(
        "INVALID_PARAMETER_VALUE",
        "offer_type is not supported",
        "/offer_type",
      );
    const cents = toCents(a.value);
    if (
      !Number.isFinite(cents) ||
      cents <= 0 ||
      a.currency_code !== d.dispute_amount.currency_code ||
      cents > toCents(d.dispute_amount.value)
    )
      throw invalid(
        "INVALID_PARAMETER_VALUE",
        "offer_amount must be positive, in the dispute currency, and not above the dispute amount",
        "/offer_amount",
      );
    if (d.status !== "WAITING_FOR_SELLER_RESPONSE")
      throw unprocessable("NOT_ALLOWED", "Dispute does not accept an offer");
    d.offer = {
      buyer_requested_amount: d.dispute_amount,
      offer_type: type,
      seller_offered_amount: a,
      history: [
        {
          offer_time: new Date(ctx.state.config.now).toISOString(),
          actor: "SELLER",
          event_type: "PROPOSED",
          notes: b.note,
          offer_type: type,
          offer_amount: a,
        },
      ],
    };
    d.status = "WAITING_FOR_BUYER_RESPONSE";
    delete d.seller_response_due_date;
    touch(d);
    return {
      status: 200,
      body: {
        links: [
          {
            href: `http://${ctx.host}/v1/customer/disputes/${d.dispute_id}`,
            rel: "self",
            method: "GET",
          },
        ],
      },
    };
  }),

  route("POST", "/v1/customer/disputes/:id/accept-claim", (ctx) => {
    const d = get(ctx);
    const b = ctx.json<{
      note?: string;
      refund_amount?: { currency_code: string; value: string };
    }>();
    if (!b?.note)
      throw invalid("MISSING_REQUIRED_PARAMETER", "note is required", "/note");
    if (d.status === "RESOLVED")
      throw unprocessable("NOT_ALLOWED", "Dispute is already resolved"); // unverified
    const refund = b.refund_amount ?? d.dispute_amount;
    d.status = "RESOLVED";
    d.outcome = "RESOLVED_BUYER_FAVOUR";
    d.dispute_outcome = {
      outcome_code: "RESOLVED_BUYER_FAVOUR",
      amount_refunded: refund,
    };
    delete d.seller_response_due_date;
    touch(d);
    ctx.state.addTransaction(
      ctx.state.newTransaction(
        "T1201",
        -toCents(refund.value),
        refund.currency_code,
        `Dispute ${d.dispute_id} accepted`,
        Date.now(),
      ),
    );
    return {
      status: 200,
      body: {
        links: [
          {
            href: `http://${ctx.host}/v1/customer/disputes/${d.dispute_id}`,
            rel: "self",
            method: "GET",
          },
        ],
      },
    };
  }),

  route(
    "POST",
    "/mock/disputes",
    (ctx) => {
      const b = ctx.raw.length
        ? ctx.json<{
            transaction_id?: string;
            reason?: Dispute["reason"];
            amount?: string;
            status?: DisputeStatus;
            dispute_id?: string;
            messages?: Dispute["messages"] | string[];
            items?: {
              item_description: string;
              item_quantity?: string | number;
            }[];
            evidences?: Evidence[];
            stage?: Dispute["dispute_life_cycle_stage"];
            due_in_days?: number;
            outcome?: "RESOLVED_SELLER_FAVOUR" | "RESOLVED_BUYER_FAVOUR";
            buyer_name?: string;
          }>()
        : {};
      const payments = ctx.state.transactions.filter(
        (t) => t.transaction_info.transaction_event_code === "T0006",
      );
      const t =
        (b.transaction_id
          ? payments.find(
              (x) => x.transaction_info.transaction_id === b.transaction_id,
            )
          : undefined) ?? payments[payments.length - 1];
      if (!t) throw notFound("Transaction", b.transaction_id ?? "(any)");
      const now = Date.now();
      const status = b.status ?? "WAITING_FOR_SELLER_RESPONSE";
      const amount = b.amount
        ? {
            currency_code: t.transaction_info.transaction_amount.currency_code,
            value: b.amount,
          }
        : t.transaction_info.transaction_amount;
      const nowIso = new Date(now).toISOString();
      const buyerName =
        b.buyer_name ??
        `${t.payer_info.payer_name.given_name} ${t.payer_info.payer_name.surname}`;
      const messages: Dispute["messages"] = (b.messages ?? []).map((m) =>
        typeof m === "string"
          ? { posted_by: "BUYER" as const, time_posted: nowIso, content: m }
          : { ...m, time_posted: m.time_posted ?? nowIso },
      );
      if (messages.length === 0)
        messages.push({
          posted_by: "BUYER",
          time_posted: nowIso,
          content: "Opened through the mock helper.",
        });
      const dueMs = (b.due_in_days ?? 10) * DAY;
      const resolvedOutcome =
        status === "RESOLVED"
          ? (b.outcome ?? "RESOLVED_SELLER_FAVOUR")
          : undefined;
      const d: Dispute = {
        dispute_id:
          b.dispute_id ?? `PP-D-${Math.floor(Math.random() * 9e9 + 1e9)}`,
        create_time: new Date(now).toISOString(),
        update_time: new Date(now).toISOString(),
        reason:
          b.reason ??
          DISPUTE_REASONS[Math.floor(Math.random() * DISPUTE_REASONS.length)]!,
        status,
        dispute_amount: money(toCents(amount.value), amount.currency_code),
        dispute_life_cycle_stage: b.stage ?? DISPUTE_STAGES[0]!,
        dispute_channel: "INTERNAL",
        disputed_transactions: [
          {
            seller_transaction_id: t.transaction_info.transaction_id,
            create_time: t.transaction_info.transaction_initiation_date,
            transaction_status: "COMPLETED",
            gross_amount: amount,
            buyer: { name: buyerName },
            seller: { merchant_id: "MOCKMERCHANT01", name: "Mock Merchant" },
            ...(b.items
              ? {
                  items: b.items.map((i) => ({
                    item_description: i.item_description,
                    item_quantity: String(i.item_quantity ?? 1),
                  })),
                }
              : {}),
          },
        ],
        ...(status === "WAITING_FOR_SELLER_RESPONSE" || status === "OPEN"
          ? { seller_response_due_date: new Date(now + dueMs).toISOString() }
          : {}),
        ...(resolvedOutcome
          ? {
              outcome: resolvedOutcome,
              dispute_outcome: {
                outcome_code: resolvedOutcome,
                ...(resolvedOutcome === "RESOLVED_BUYER_FAVOUR"
                  ? {
                      amount_refunded: money(
                        toCents(amount.value),
                        amount.currency_code,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
        messages,
        evidences: b.evidences ?? [],
        links: [],
      };
      void liveId;
      ctx.state.disputes.set(d.dispute_id, d);
      return { status: 201, body: full(ctx, d) };
    },
    false,
  ),
];
