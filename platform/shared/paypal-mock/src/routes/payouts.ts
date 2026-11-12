import type {
  CreatePayoutRequest,
  PayoutBatch,
  PayoutItem,
} from "@jeirslab/paypal-client/types";
import {
  ApiError,
  invalid,
  notFound,
  route,
  type Ctx,
  type Route,
} from "../http.js";
import { fromCents, toCents, VALUE_RE } from "../money.js";
import type { PayoutBatchRec } from "../state.js";

const itemLinks = (ctx: Ctx, it: PayoutItem) => [
  {
    href: `http://${ctx.host}/v1/payments/payouts-item/${it.payout_item_id}`,
    rel: "item",
    method: "GET",
  },
];

function render(
  ctx: Ctx,
  rec: PayoutBatchRec,
  page: number,
  pageSize: number,
): PayoutBatch {
  const st = ctx.state.payoutStatus(rec);
  const first = rec.items[0]?.payout_item.amount.currency ?? "USD";
  const total = rec.items.reduce(
    (a, it) => a + toCents(it.payout_item.amount.value),
    0,
  );
  const fees = rec.items.reduce(
    (a, it) => a + toCents(it.payout_item_fee.value),
    0,
  );
  const slice = rec.items.slice((page - 1) * pageSize, page * pageSize);
  return {
    batch_header: {
      payout_batch_id: rec.id,
      batch_status: st,
      time_created: new Date(rec.createdMs).toISOString(),
      ...(st === "SUCCESS"
        ? {
            time_completed: new Date(
              rec.createdMs + ctx.state.config.payoutSeconds * 1000,
            ).toISOString(),
          }
        : {}),
      sender_batch_header: rec.header,
      amount: { currency: first, value: fromCents(total) },
      fees: { currency: first, value: fromCents(fees) },
    },
    items: slice.map((it) => ({
      ...it,
      transaction_status: st === "SUCCESS" ? it.transaction_status : "PENDING",
      links: itemLinks(ctx, it),
    })),
    total_items: rec.items.length,
    total_pages: Math.max(1, Math.ceil(rec.items.length / pageSize)),
    links: [
      {
        href: `http://${ctx.host}/v1/payments/payouts/${rec.id}`,
        rel: "self",
        method: "GET",
      },
    ],
  };
}

export const payoutRoutes: Route[] = [
  route("POST", "/v1/payments/payouts", (ctx) => {
    const body = ctx.json<CreatePayoutRequest>();
    const h = body?.sender_batch_header;
    if (!h?.sender_batch_id)
      throw invalid(
        "MISSING_REQUIRED_PARAMETER",
        "sender_batch_header.sender_batch_id is required",
        "/sender_batch_header/sender_batch_id",
      );
    if (!Array.isArray(body.items) || body.items.length === 0)
      throw invalid(
        "MISSING_REQUIRED_PARAMETER",
        "items is required",
        "/items",
      );
    body.items.forEach((it, i) => {
      if (!VALUE_RE.test(it.amount?.value ?? "") || !it.amount?.currency) {
        throw invalid(
          "INVALID_PARAMETER_VALUE",
          `items[${i}].amount is invalid`,
          `/items/${i}/amount`,
        );
      }
      if (!it.receiver)
        throw invalid(
          "MISSING_REQUIRED_PARAMETER",
          `items[${i}].receiver is required`,
          `/items/${i}/receiver`,
        );
    });
    if (ctx.state.batchIds.has(h.sender_batch_id)) {
      throw new ApiError(
        400,
        "DUPLICATE_REQUEST_ID",
        "Duplicate sender_batch_id",
        [
          {
            issue: "DUPLICATE_REQUEST_ID",
            description: "sender_batch_id was already used",
          },
        ],
      ); // unverified
    }
    const rec = ctx.state.createPayout(body);
    return {
      status: 201,
      body: {
        batch_header: {
          payout_batch_id: rec.id,
          batch_status: "PENDING",
          sender_batch_header: rec.header,
        },
        links: [
          {
            href: `http://${ctx.host}/v1/payments/payouts/${rec.id}`,
            rel: "self",
            method: "GET",
          },
        ],
      },
    };
  }),

  route("GET", "/v1/payments/payouts/:id", (ctx) => {
    const rec = ctx.state.payouts.get(ctx.params["id"]!);
    if (!rec) throw notFound("Payout batch", ctx.params["id"]!);
    ctx.state.settlePayouts();
    const page = Math.max(
      1,
      Number(ctx.url.searchParams.get("page") ?? 1) || 1,
    );
    const size = Math.min(
      1000,
      Math.max(
        1,
        Number(ctx.url.searchParams.get("page_size") ?? 1000) || 1000,
      ),
    );
    return { status: 200, body: render(ctx, rec, page, size) };
  }),

  route("GET", "/v1/payments/payouts-item/:id", (ctx) => {
    for (const rec of ctx.state.payouts.values()) {
      const it = rec.items.find((x) => x.payout_item_id === ctx.params["id"]);
      if (it) {
        ctx.state.settlePayouts();
        return { status: 200, body: { ...it, links: itemLinks(ctx, it) } };
      }
    }
    throw notFound("Payout item", ctx.params["id"]!);
  }),
];
