import type { PayPalErrorDetail } from "./types.js";

export class PayPalApiError extends Error {
  status: number;
  debugId?: string;
  details: PayPalErrorDetail[];
  issue?: string;
  constructor(
    status: number,
    body: {
      name?: string;
      message?: string;
      debug_id?: string;
      details?: PayPalErrorDetail[];
      error?: string;
      error_description?: string;
    },
  ) {
    super(
      body.message ?? body.error_description ?? `PayPal API error ${status}`,
    );
    this.status = status;
    this.name = body.name ?? body.error ?? "PayPalApiError";
    if (body.debug_id) this.debugId = body.debug_id;
    this.details = body.details ?? [];
    const issue = this.details[0]?.issue;
    if (issue) this.issue = issue;
  }
}
