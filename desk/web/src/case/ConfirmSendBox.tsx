import React, { useEffect, useRef } from "react";
import type { Claim } from "../lib/api";

export type ConfirmSendBoxProps = {
  kind: "evidence" | "accept" | "offer";
  /** the exact PayPal call this click sends */
  call?: string;
  text: string;
  okLabel: string;
  claims: Claim[];
  onToggle(i: number, ok: boolean): void;
  onRecheck(): void;
  onConfirm(): void;
  onCancel(): void;
  busy: boolean;
};

// the server's reason, one line per clause, capitalised, no trailing period
const reasonLines = (reason: string) =>
  reason
    .replace(/^./, (ch) => ch.toUpperCase())
    .split(/;\s*|\.\s+(?=[A-Za-z])/)
    .filter(Boolean)
    .map((p) => p.replace(/\.$/, ""));

export function ConfirmSendBox(p: ConfirmSendBoxProps) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), []);
  const idx = p.claims.map((c, i) => [c, i] as const);
  const block = (list: typeof idx, head: string, label: string) =>
    list.length > 0 && (
      <>
        <p className="claims-head">{head}</p>
        {list.map(([c, i]) => (
          <div className="claim" key={i}>
            <blockquote>{c.sentence}</blockquote>
            {c.kind !== "added" && (
              <div className="muted">
                {reasonLines(c.reason ?? "").map((l, k) => (
                  <div key={k}>{l}</div>
                ))}
              </div>
            )}
            <label>
              <input type="checkbox" checked={c.ok} onChange={(e) => p.onToggle(i, e.target.checked)} />{" "}
              {label}
            </label>
          </div>
        ))}
      </>
    );
  return (
    <div
      className="confirm"
      role="alertdialog"
      aria-labelledby="confirm-text"
      onKeyDown={(e) => e.key === "Escape" && p.onCancel()}
    >
      <p id="confirm-text">{p.text}</p>
      {p.call && <code>{p.call}</code>}
      {p.claims.length > 0 && (
        <div>
          {block(
            idx.filter(([c]) => c.kind === "added"),
            "You added these statements. PayPal reads them as claims; confirm you hold evidence for each:",
            "I hold evidence for this statement",
          )}
          {block(
            idx.filter(([c]) => c.kind !== "added"),
            "PayPal would see claims with no evidence on file:",
            "I have this evidence",
          )}
          <p className="muted">
            Fix these sentences in your draft, or tick the box under each.{" "}
            <button type="button" onClick={p.onRecheck}>
              Check again
            </button>
          </p>
        </div>
      )}
      <div className="actions">
        <button
          ref={okRef}
          className="primary"
          type="button"
          disabled={p.busy || p.claims.some((c) => !c.ok)}
          onClick={p.onConfirm}
        >
          {p.okLabel}
        </button>
        <button type="button" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
