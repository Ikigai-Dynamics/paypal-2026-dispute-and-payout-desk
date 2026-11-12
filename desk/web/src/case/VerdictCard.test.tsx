import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VerdictCard } from "./VerdictCard";
import type { Decision } from "../lib/api";

const offerDecision = {
  contract: "decide.v1",
  p0: 0.5,
  p0_source: "x",
  k: 4,
  wins: 3,
  n: 6,
  p: 0.62,
  p_lo: 0.48,
  p_hi: 0.75,
  ev_accept_cents: -8000,
  ev_fight_cents: -5000,
  margin_cents: 0,
  marginal: false,
  call: "offer",
  terms: [],
  offer: { amount_cents: 3000, q: 0.7, ev_cents: -3500 },
  keep_cents: 4500,
} as Decision;

describe("VerdictCard", () => {
  it("says Offer $X back with the interval, and the primary button sends the offer", () => {
    const onOffer = vi.fn();
    render(
      <VerdictCard
        decision={offerDecision}
        amountCents={8000}
        currency="USD"
        precedents={[]}
        checklist={[]}
        canAct
        fightAnyway={false}
        busy={false}
        sent={null}
        onOffer={onOffer}
        onFight={() => {}}
        onReview={() => {}}
        onRefund={() => {}}
      />,
    );
    expect(screen.getByText("Parley says: Offer $30.00 back")).toBeInTheDocument();
    expect(screen.getByText(/62% \(48–75%\) estimated chance to win/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send $30.00 offer" }));
    expect(onOffer).toHaveBeenCalledWith(3000);
  });

  const props = {
    amountCents: 8000,
    currency: "USD",
    precedents: [],
    checklist: [],
    canAct: true,
    fightAnyway: false,
    busy: false,
    sent: null,
    onOffer: () => {},
    onFight: () => {},
    onReview: () => {},
    onRefund: () => {},
  };

  it("says Refund $X in full for an accept call and explains a flagged buyer", () => {
    const d = { ...offerDecision, call: "accept", offer: null, buyer_flag: true, buyer_orders: 8, buyer_disputes: 8 } as Decision;
    render(<VerdictCard {...props} decision={d} />);
    expect(screen.getByText("Parley says: Refund $80.00 in full")).toBeInTheDocument();
    expect(
      screen.getByText(/Buyer has disputed 8 of 8 orders with you: Parley would not offer a partial refund\./),
    ).toBeInTheDocument();
  });

  it("shows no buyer line when the buyer is not flagged", () => {
    render(<VerdictCard {...props} decision={offerDecision} />);
    expect(screen.queryByText(/Buyer has disputed/)).toBeNull();
  });
});
