import React from "react";

export type DraftEditorProps = {
  value: string;
  onChange(v: string): void;
  label: string;
  labelGreen: boolean;
  dim: boolean;
  flagged: boolean;
  note: { text: string; error: boolean } | null;
  claimNote: boolean;
  fightNote: boolean;
  newDraft?: boolean;
  onUseNewDraft?(): void;
};

export function DraftEditor(p: DraftEditorProps) {
  const cls = [p.dim ? "dim" : "", p.flagged ? "flagged" : ""].join(" ").trim();
  return (
    <>
      {p.fightNote && (
        <p className="muted">
          <strong>You chose to fight this case (the desk recommended Accept)</strong>
        </p>
      )}
      <h3>
        Response to PayPal{" "}
        <span className={"pill " + (p.labelGreen ? "green" : "grey")}>{p.label}</span>
      </h3>
      {p.newDraft && (
        <p className="muted">
          A new AI draft is ready{" "}
          <button type="button" onClick={p.onUseNewDraft}>
            Use it
          </button>
        </p>
      )}
      {p.note && <p className={p.note.error ? "formerr" : "muted"}>{p.note.text}</p>}
      {p.claimNote && (
        <p className="formerr">Fix these sentences in your draft, or tick the box under each one.</p>
      )}
      <textarea
        rows={9}
        className={cls}
        aria-label="Response to PayPal"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </>
  );
}
