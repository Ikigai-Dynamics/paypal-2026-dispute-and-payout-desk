import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SituationHeader } from "./SituationHeader";
import type { CaseSummary } from "../lib/api";

const day = 86400000;
const mk = (id: string, buyer: string, call: string, days: number, cents = 10000): CaseSummary => ({
  dispute_id: id,
  reason: "OTHER",
  stage: "CHARGEBACK",
  status: "WAITING_FOR_SELLER_RESPONSE",
  outcome: null,
  amount_cents: cents,
  currency: "USD",
  buyer,
  item: null,
  item_quantity: null,
  items: [],
  due_at: new Date(Date.now() + days * day).toISOString(),
  days_left: days,
  evidence_on_file: false,
  call,
});

const show = (cases: CaseSummary[], onOpen = vi.fn()) => {
  render(
    <SituationHeader info={null} aiOn={false} cases={cases} summary={null} loadError={false} onOpen={onOpen} />,
  );
  return onOpen;
};

describe("SituationHeader", () => {
  it("opens the soonest fight case even when an accept case is due first", () => {
    const onOpen = show([
      mk("A", "Priya Nair", "accept", 1, 16400),
      mk("F", "Sofia Lindqvist", "fight", 5, 131700),
    ]);
    const btn = screen.getByRole("button", { name: "Fight the most urgent dispute" });
    expect(screen.getByText(/Priya Nair is due first but is an Accept; opening Sofia Lindqvist/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith("F");
  });

  it("falls back to the first case when nothing is a fight", () => {
    const onOpen = show([mk("A", "Priya Nair", "accept", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "Start with the most urgent case" }));
    expect(onOpen).toHaveBeenCalledWith("A");
  });
});
