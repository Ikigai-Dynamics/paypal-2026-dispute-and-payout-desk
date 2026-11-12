import type {
  Authorization,
  Capture,
  CreateOrderRequest,
  Order,
  PurchaseUnit,
} from "@jeirslab/paypal-client/types";
import {
  invalid,
  notFound,
  route,
  unprocessable,
  type Ctx,
  type Route,
} from "../http.js";
import { money, paypalFeeCents, toCents, VALUE_RE } from "../money.js";
import { liveId } from "../state.js";

const links = (ctx: Ctx, id: string) => [
  {
    href: `http://${ctx.host}/v2/checkout/orders/${id}`,
    rel: "self",
    method: "GET",
  },
  {
    href: `http://${ctx.host}/checkoutnow?token=${id}`,
    rel: "approve",
    method: "GET",
  },
  {
    href: `http://${ctx.host}/v2/checkout/orders/${id}`,
    rel: "update",
    method: "PATCH",
  },
  {
    href: `http://${ctx.host}/v2/checkout/orders/${id}/capture`,
    rel: "capture",
    method: "POST",
  },
];

function validate(body: CreateOrderRequest): void {
  if (!body || (body.intent !== "CAPTURE" && body.intent !== "AUTHORIZE")) {
    throw invalid(
      "INVALID_PARAMETER_VALUE",
      "intent must be CAPTURE or AUTHORIZE",
      "/intent",
    );
  }
  if (!Array.isArray(body.purchase_units) || body.purchase_units.length === 0) {
    throw invalid(
      "MISSING_REQUIRED_PARAMETER",
      "purchase_units is required",
      "/purchase_units",
    );
  }
  body.purchase_units.forEach((u, i) => {
    const f = `/purchase_units/@reference_id=='${u.reference_id ?? "default"}'/amount`;
    if (!u.amount || !/^[A-Z]{3}$/.test(u.amount.currency_code ?? "")) {
      throw invalid(
        "CURRENCY_CODE_INVALID",
        `purchase_units[${i}].amount.currency_code must be a 3-letter code`,
        f,
      ); // unverified
    }
    if (!VALUE_RE.test(u.amount.value ?? "")) {
      throw invalid(
        "DECIMAL_PRECISION",
        `purchase_units[${i}].amount.value must be a decimal string with 2 places`,
        `${f}/value`,
      );
    }
  });
}

export const MOCK_PAYER = {
  email_address: "buyer@example.com",
  account_id: "MOCKBUYER0001",
  name: { given_name: "Mock", surname: "Buyer" },
};

/** A COMPLETED Capture with the PayPal fee; also records its T0006 transaction. */
export function makeCapture(
  ctx: Ctx,
  cents: number,
  cur: string,
  finalCapture: boolean,
  subject: string,
  extra: { invoice_id?: string; custom_id?: string } = {},
): Capture {
  const now = new Date().toISOString();
  const fee = paypalFeeCents(cents);
  const cap: Capture = {
    id: liveId(17),
    status: "COMPLETED",
    amount: money(cents, cur),
    final_capture: finalCapture,
    seller_protection: {
      status: "ELIGIBLE",
      dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"],
    },
    seller_receivable_breakdown: {
      gross_amount: money(cents, cur),
      paypal_fee: money(fee, cur),
      net_amount: money(cents - fee, cur),
    },
    create_time: now,
    update_time: now,
    links: [],
  };
  cap.links = [
    {
      href: `http://${ctx.host}/v2/payments/captures/${cap.id}`,
      rel: "self",
      method: "GET",
    },
  ];
  const t = ctx.state.newTransaction(
    "T0006",
    cents,
    cur,
    subject,
    Date.now(),
    fee,
  );
  t.transaction_info.transaction_id = cap.id;
  if (extra.invoice_id) t.transaction_info.invoice_id = extra.invoice_id;
  if (extra.custom_id) t.transaction_info.custom_field = extra.custom_id;
  ctx.state.addTransaction(t);
  return cap;
}

export const orderRoutes: Route[] = [
  route("POST", "/v2/checkout/orders", (ctx) => {
    const body = ctx.json<CreateOrderRequest>();
    validate(body);
    const id = liveId(17);
    const units: PurchaseUnit[] = body.purchase_units.map((u) => ({
      ...u,
      reference_id: u.reference_id ?? "default",
    }));
    const order: Order = {
      id,
      intent: body.intent,
      status: body.payment_source?.paypal ? "PAYER_ACTION_REQUIRED" : "CREATED",
      purchase_units: units,
      create_time: new Date().toISOString(),
      links: [],
    };
    ctx.state.orders.set(id, order);
    return { status: 201, body: { ...order, links: links(ctx, id) } };
  }),

  route("GET", "/v2/checkout/orders/:id", (ctx) => {
    const o = ctx.state.orders.get(ctx.params["id"]!);
    if (!o) throw notFound("Order", ctx.params["id"]!);
    return { status: 200, body: { ...o, links: links(ctx, o.id) } };
  }),

  route("POST", "/v2/checkout/orders/:id/capture", (ctx) => {
    const id = ctx.params["id"]!;
    const o = ctx.state.orders.get(id);
    if (!o) throw notFound("Order", id);
    if (o.status === "COMPLETED")
      throw unprocessable(
        "ORDER_ALREADY_CAPTURED",
        "Order already captured. If 'intent=CAPTURE' only one capture per order ID is allowed.",
      );
    if (o.status !== "APPROVED") {
      if (!ctx.state.config.autoApprove)
        throw unprocessable(
          "ORDER_NOT_APPROVED",
          "Payer has not yet approved the Order for payment.",
        );
    }
    const payer = MOCK_PAYER;
    const now = new Date().toISOString();
    o.payer = payer;
    o.status = "COMPLETED";
    o.update_time = now;
    o.purchase_units = o.purchase_units.map((u) => ({
      ...u,
      payments: {
        captures: [
          makeCapture(
            ctx,
            toCents(u.amount.value),
            u.amount.currency_code,
            true,
            u.description ?? `Order ${id}`,
            u,
          ),
        ],
      },
    }));
    return {
      status: 201,
      body: {
        id,
        status: "COMPLETED",
        payment_source: {
          paypal: {
            email_address: payer.email_address,
            account_id: payer.account_id,
            name: payer.name,
          },
        },
        payer,
        purchase_units: o.purchase_units,
        links: [
          {
            href: `http://${ctx.host}/v2/checkout/orders/${id}`,
            rel: "self",
            method: "GET",
          },
        ],
      },
    };
  }),

  route("POST", "/v2/checkout/orders/:id/authorize", (ctx) => {
    const id = ctx.params["id"]!;
    const o = ctx.state.orders.get(id);
    if (!o) throw notFound("Order", id);
    if (o.status === "COMPLETED")
      throw unprocessable(
        "ORDER_ALREADY_AUTHORIZED",
        "Order already authorized. If 'intent=AUTHORIZE' only one authorization per order ID is allowed.",
      );
    if (o.intent !== "AUTHORIZE")
      throw unprocessable(
        "ACTION_DOES_NOT_MATCH_INTENT",
        "Order was created with an intent to 'CAPTURE'. Please use /v2/checkout/orders/{order_id}/capture.",
      );
    if (o.status !== "APPROVED" && !ctx.state.config.autoApprove)
      throw unprocessable(
        "ORDER_NOT_APPROVED",
        "Payer has not yet approved the Order for payment.",
      );
    const now = new Date();
    o.payer = MOCK_PAYER;
    o.status = "COMPLETED";
    o.update_time = now.toISOString();
    o.purchase_units = o.purchase_units.map((u) => {
      const auth: Authorization = {
        id: liveId(17),
        status: "CREATED",
        amount: { ...u.amount },
        expiration_time: new Date(
          now.getTime() + 29 * 86_400_000,
        ).toISOString(),
        create_time: now.toISOString(),
        update_time: now.toISOString(),
        links: [],
      };
      auth.links = [
        {
          href: `http://${ctx.host}/v2/payments/authorizations/${auth.id}`,
          rel: "self",
          method: "GET",
        },
        {
          href: `http://${ctx.host}/v2/payments/authorizations/${auth.id}/capture`,
          rel: "capture",
          method: "POST",
        },
        {
          href: `http://${ctx.host}/v2/payments/authorizations/${auth.id}/void`,
          rel: "void",
          method: "POST",
        },
      ];
      ctx.state.authorizations.set(auth.id, {
        auth,
        orderId: id,
        capturedCents: 0,
        currency: u.amount.currency_code,
        description: u.description ?? `Order ${id}`,
      });
      return { ...u, payments: { captures: [], authorizations: [auth] } };
    });
    return {
      status: 201,
      body: {
        ...o,
        payment_source: { paypal: { ...MOCK_PAYER } },
        links: [
          {
            href: `http://${ctx.host}/v2/checkout/orders/${id}`,
            rel: "self",
            method: "GET",
          },
        ],
      },
    };
  }),

  route(
    "POST",
    "/mock/orders/:id/approve",
    (ctx) => {
      const o = ctx.state.orders.get(ctx.params["id"]!);
      if (!o) throw notFound("Order", ctx.params["id"]!);
      if (o.status !== "COMPLETED") {
        o.status = "APPROVED";
        o.payer = MOCK_PAYER;
      }
      return { status: 200, body: { ...o, links: links(ctx, o.id) } };
    },
    false,
  ),
];
