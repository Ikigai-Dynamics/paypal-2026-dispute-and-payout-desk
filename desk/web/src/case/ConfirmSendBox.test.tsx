import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmSendBox } from "./ConfirmSendBox";
import type { Claim } from "../lib/api";

const noop = () => {};

function Wrapper({ claims: initial, onCancel = noop }: { claims: Claim[]; onCancel?: () => void }) {
  const [claims, setClaims] = useState(initial);
  return (
    <ConfirmSendBox
      kind="evidence"
      text="Send?"
      okLabel="Send to PayPal"
      claims={claims}
      onToggle={(i, ok) => setClaims(claims.map((c, k) => (k === i ? { ...c, ok } : c)))}
      onRecheck={noop}
      onConfirm={noop}
      onCancel={onCancel}
      busy={false}
    />
  );
}

describe("ConfirmSendBox", () => {
  it("enables Send only once every added sentence is attested", () => {
    render(
      <Wrapper
        claims={[
          { sentence: "The parcel was signed for.", kind: "added", ok: false },
          { sentence: "We refunded the shipping.", kind: "added", ok: false },
        ]}
      />,
    );
    const send = screen.getByRole("button", { name: "Send to PayPal" });
    expect(send).toBeDisabled();
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    expect(send).toBeDisabled();
    fireEvent.click(boxes[1]!);
    expect(send).toBeEnabled();
  });

  it("is enabled at once with no claims", () => {
    render(
      <ConfirmSendBox kind="accept" text="Refund?" okLabel="Refund" claims={[]}
        onToggle={noop} onRecheck={noop} onConfirm={noop} onCancel={noop} busy={false} />,
    );
    expect(screen.getByRole("button", { name: "Refund" })).toBeEnabled();
  });

  it("is disabled while busy", () => {
    render(
      <ConfirmSendBox kind="accept" text="Refund?" okLabel="Refund" claims={[]}
        onToggle={noop} onRecheck={noop} onConfirm={noop} onCancel={noop} busy />,
    );
    expect(screen.getByRole("button", { name: "Refund" })).toBeDisabled();
  });

  it("needs both a added and an unsupported claim ticked, and shows reasons without a trailing period", () => {
    render(
      <Wrapper
        claims={[
          { sentence: "We refunded the shipping.", kind: "added", ok: false },
          { sentence: "UPS delivered it Oct 30.", kind: "unsupported", reason: "no tracking on file; no delivery record.", ok: false },
        ]}
      />,
    );
    expect(screen.getByText("No tracking on file")).toBeInTheDocument();
    expect(screen.getByText("no delivery record")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send to PayPal" });
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    expect(send).toBeDisabled();
    fireEvent.click(boxes[1]!);
    expect(send).toBeEnabled();
  });

  it("calls onCancel on Escape", () => {
    let n = 0;
    render(<Wrapper claims={[]} onCancel={() => n++} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(n).toBe(1);
  });

  it("reads as a sentence first and keeps the PayPal call behind a disclosure", () => {
    render(
      <ConfirmSendBox kind="offer" text="Offer $47.00 back to Sofia Lindqvist through PayPal?" okLabel="Send offer"
        call={'POST /v1/customer/disputes/PP-D-1/make-offer {"offer_amount": {"currency_code": "USD", "value": "47.00"}, "offer_type": "REFUND"}'}
        claims={[]} onToggle={noop} onRecheck={noop} onConfirm={noop} onCancel={noop} busy={false} />,
    );
    expect(screen.getByText("Offer $47.00 back to Sofia Lindqvist through PayPal?")).toBeInTheDocument();
    const d = screen.getByText("Show the PayPal call").closest("details")!;
    expect(d).not.toHaveAttribute("open");
    expect(d.querySelector("pre")!.textContent).toContain('POST /v1/customer/disputes/PP-D-1/make-offer\n{\n  "offer_amount"');
  });
});
