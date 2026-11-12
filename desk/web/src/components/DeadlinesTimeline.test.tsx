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
  it("puts a dot on each due day and opens that case on click", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <DeadlinesTimeline cases={[mk("T", 0), mk("D", 2)]} onOpen={onOpen} />,
    );
    const days = [...container.querySelectorAll(".day")];
    expect(days).toHaveLength(14);
    expect(days[0]!.querySelectorAll(".dd")).toHaveLength(1);
    expect(days[2]!.querySelectorAll(".dd")).toHaveLength(1);
    fireEvent.click(days[2]!.querySelector(".dd")!);
    expect(onOpen).toHaveBeenCalledWith("D");
  });
});
