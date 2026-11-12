import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DisputeList } from "./DisputeList";
import type { CaseSummary } from "../lib/api";

const day = (n: number) => new Date(Date.now() + n * 86400000 + 3600000).toISOString();
const mk = (id: string, status: string, due: number): CaseSummary =>
  ({ dispute_id: id, reason: "OTHER", stage: "INQUIRY", status, outcome: null, amount_cents: 1000, currency: "USD", buyer: "B", item: `Item ${id}`,
    item_quantity: 1, items: [], due_at: day(due), days_left: due, evidence_on_file: false }) as CaseSummary;

describe("DisputeList groups", () => {
  it("splits due this week from later and keeps answered cases in a waiting group", () => {
    render(
      <DisputeList
        cases={[mk("a", "WAITING_FOR_SELLER_RESPONSE", 2), mk("b", "WAITING_FOR_SELLER_RESPONSE", 12), mk("c", "WAITING_FOR_BUYER_RESPONSE", 5)]}
        selectedId={null} lit={null} onOpen={() => {}} onClearFilter={() => {}}
      />,
    );
    expect(screen.getByText(/Due this week/).textContent).toContain("1");
    expect(screen.getByText(/^Later/).textContent).toContain("1");
    expect(screen.getByText(/Waiting on the buyer or PayPal/).textContent).toContain("1");
    expect(screen.getByText("Offer sent · waiting for buyer")).toBeInTheDocument();
  });
});
