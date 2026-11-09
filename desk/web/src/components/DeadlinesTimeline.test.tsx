import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { DeadlinesTimeline } from "./DeadlinesTimeline";
import type { CaseSummary } from "../lib/api";

const mk = (id: string, days: number): CaseSummary => ({
  dispute_id: id,
  reason: "OTHER",
  stage: "CHARGEBACK",
  status: "WAITING_FOR_SELLER_RESPONSE",
  outcome: null,
  amount_cents: 1000,
  currency: "USD",
  buyer: id,
  item: null,
  item_quantity: null,
  items: [],
  due_at: new Date(Date.now() + days * 86400000).toISOString(),
  days_left: days,
  evidence_on_file: false,
  call: "fight",
});

describe("DeadlinesTimeline", () => {
  it("places today at now and in 2 days at +2d, and opens a case on click", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <DeadlinesTimeline cases={[mk("T", 0), mk("D", 2)]} onOpen={onOpen} />,
    );
    const left = (i: number) => (container.querySelectorAll<HTMLElement>(".marker")[i]!).style.left;
    expect(left(0)).toBe("2%");
    expect(parseFloat(left(1))).toBeCloseTo((2 / 21) * 96 + 2, 5);
    fireEvent.click(container.querySelectorAll(".marker")[1]!);
    expect(onOpen).toHaveBeenCalledWith("D");
  });
});
