import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmSendBox } from "./ConfirmSendBox";
import type { Claim } from "./types";

const noop = () => {};

function Wrapper({ claims: initial }: { claims: Claim[] }) {
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
      onCancel={noop}
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
});
