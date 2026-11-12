import { describe, expect, it } from "vitest";
import { callLabel } from "./PayPalFooter";

const call = (path: string, amount_cents: number) => ({
  at: "2026-11-12T12:00:00Z",
  method: "POST",
  path: `/v1/customer/disputes/PP-D-1/${path}`,
  status: 200,
  ms: 5,
  buyer: "Sofia Lindqvist",
  amount_cents,
  currency: "USD",
});

describe("callLabel", () => {
  it("says what money moved, in words", () => {
    expect(callLabel(call("make-offer", 4700))).toBe("Offered $47.00 to Sofia Lindqvist · PayPal make-offer");
    expect(callLabel(call("accept-claim", 10000))).toBe("Refunded $100.00 to Sofia Lindqvist · PayPal accept-claim");
    expect(callLabel(call("provide-evidence", 10000))).toBe("Sent evidence for Sofia Lindqvist · PayPal provide-evidence");
  });
});
