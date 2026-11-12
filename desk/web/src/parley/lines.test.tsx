import { describe, expect, it } from "vitest";
import { line } from "./lines";
import type { CaseSummary } from "../lib/api";

const c = (o: Partial<CaseSummary>) =>
  ({ buyer: "Ann B", item: "Mug", amount_cents: 16400, currency: "USD", status: "WAITING_FOR_SELLER_RESPONSE", ...o }) as CaseSummary;

describe("line", () => {
  it("fight: same numbers as the card, whole-dollar margin, draft note", () => {
    expect(line(c({ call: "fight", p: 0.55, margin_cents: 4012 }), true)).toBe(
      "I put your chance of winning at **55%**. Fighting beats refunding by about **$40**. Your reply is drafted for you to check.",
    );
    expect(line(c({ call: "fight", p: 0.55 }))).toBe("I put your chance of winning at **55%**.");
  });
  it("offer, accept and waiting", () => {
    expect(line(c({ call: "offer", p: 0.38, offer_cents: 9750 }))).toBe(
      "I put your chance of winning at **38%**. Offer **$97.50** back and this is likely over.",
    );
    expect(line(c({ call: "accept" }))).toContain("**$164.00**");
    expect(line(c({ status: "UNDER_REVIEW", call: "fight" }))).toBe("This one's with PayPal now. Nothing to do until they decide.");
  });
});
