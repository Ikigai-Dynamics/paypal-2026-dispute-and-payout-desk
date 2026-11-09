import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CaseCards } from "./CaseCards";
import type { CaseSummary } from "../lib/api";

const day = 86400000;
const mk = (id: string, buyer: string, call: string, days: number): CaseSummary => ({
  dispute_id: id,
  reason: "OTHER",
  stage: "CHARGEBACK",
  status: "WAITING_FOR_SELLER_RESPONSE",
  outcome: null,
  amount_cents: 12300,
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

describe("CaseCards", () => {
  const cases = [
    mk("F", "Sofia Lindqvist", "fight", 4),
    mk("A", "Priya Nair", "accept", 2),
    mk("M", "Late Larry", "fight", -3),
  ];

  it("shows Fight and Accept chips on the cards", () => {
    render(<CaseCards cases={cases} onOpen={vi.fn()} />);
    expect(screen.getByText("Fight")).toBeInTheDocument();
    expect(screen.getByText("Accept")).toBeInTheDocument();
  });

  it("keeps a missed case out of the grid, behind a closed disclosure that opens it", () => {
    const onOpen = vi.fn();
    const { container } = render(<CaseCards cases={cases} onOpen={onOpen} />);
    expect(container.querySelectorAll(".dcard")).toHaveLength(2);
    expect(container.querySelector(".cards")!.textContent).not.toContain("Late Larry");
    const details = container.querySelector("details.missed") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("Missed deadline (1)")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Late Larry/));
    expect(onOpen).toHaveBeenCalledWith("M");
  });
});
