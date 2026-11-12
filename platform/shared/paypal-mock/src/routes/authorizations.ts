import type { Money } from "@jeirslab/paypal-client/types";
import {
  invalid,
  notFound,
  route,
  unprocessable,
  type Route,
} from "../http.js";
import { toCents, VALUE_RE } from "../money.js";
import { makeCapture } from "./orders.js";

// Payments v2 authorizations: created by POST /v2/checkout/orders/:id/authorize (orders.ts)
export const authorizationRoutes: Route[] = [
  route("GET", "/v2/payments/authorizations/:id", (ctx) => {
    const rec = ctx.state.authorizations.get(ctx.params["id"]!);
    if (!rec) throw notFound("Authorization", ctx.params["id"]!);
    return { status: 200, body: rec.auth };
  }),

  route("POST", "/v2/payments/authorizations/:id/capture", (ctx) => {
    const id = ctx.params["id"]!;
    const rec = ctx.state.authorizations.get(id);
    if (!rec) throw notFound("Authorization", id);
    if (rec.auth.status === "VOIDED")
      throw unprocessable(
        "AUTHORIZATION_VOIDED",
        "A voided authorization cannot be captured.",
      );
    if (rec.auth.status === "CAPTURED")
      throw unprocessable(
        "AUTHORIZATION_ALREADY_CAPTURED",
        "Authorization has already been captured.",
      );
    const body = ctx.json<{
      amount?: Money;
      final_capture?: boolean;
      note_to_payer?: string;
      invoice_id?: string;
    }>();
    const authorizedCents = toCents(rec.auth.amount.value);
    const remaining = authorizedCents - rec.capturedCents;
    let cents = remaining;
    if (body.amount !== undefined) {
      if (!VALUE_RE.test(body.amount.value ?? ""))
        throw invalid(
          "DECIMAL_PRECISION",
          "amount.value must be a decimal string with 2 places",
          "/amount/value",
        );
      cents = toCents(body.amount.value);
    }
    if (cents <= 0 || rec.capturedCents + cents > authorizedCents)
      throw unprocessable(
        "MAX_CAPTURE_AMOUNT_EXCEEDED",
        "Capture amount exceeds allowable limit.",
      );
    const final = body.final_capture === true;
    const cap = makeCapture(
      ctx,
      cents,
      rec.currency,
      final,
      rec.description,
      body.invoice_id ? { invoice_id: body.invoice_id } : {},
    );
    rec.capturedCents += cents;
    rec.auth.status =
      final || rec.capturedCents >= authorizedCents
        ? "CAPTURED"
        : "PARTIALLY_CAPTURED";
    rec.auth.update_time = cap.create_time;
    return { status: 201, body: cap };
  }),

  route("POST", "/v2/payments/authorizations/:id/void", (ctx) => {
    const id = ctx.params["id"]!;
    const rec = ctx.state.authorizations.get(id);
    if (!rec) throw notFound("Authorization", id);
    if (rec.auth.status === "VOIDED")
      throw unprocessable(
        "PREVIOUSLY_VOIDED",
        "Authorization has been previously voided and hence cannot be voided again.",
      );
    if (rec.capturedCents > 0)
      throw unprocessable(
        "PREVIOUSLY_CAPTURED",
        "Authorization has been previously captured and hence cannot be voided.",
      );
    rec.auth.status = "VOIDED";
    rec.auth.update_time = new Date().toISOString();
    return { status: 204 };
  }),
];
