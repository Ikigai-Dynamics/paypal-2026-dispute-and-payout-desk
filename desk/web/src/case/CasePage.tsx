import { useEffect, useRef } from "react";
import type { CaseSummary } from "../lib/api";
import {
  REASONS,
  REASON_SHORT,
  dateShort,
  inDays,
  money,
  needsResponse,
  reasonShort,
  statusWords,
} from "../lib/format";
import { useCase } from "./useCase";
import { Recommendation } from "./Recommendation";
import { ShowTheMath } from "./ShowTheMath";
import { EvidenceOnFile } from "./EvidenceOnFile";
import { SentState } from "./SentState";
import { Checklist } from "./Checklist";
import { DraftEditor } from "./DraftEditor";
import { ConfirmSendBox } from "./ConfirmSendBox";

export interface CasePageProps {
  id: string;
  cases: CaseSummary[];
  onClose(): void;
  onWritten(): Promise<void>;
  onAiDraft(): void;
}

// disputes of this buyer waiting for a response and not past their deadline
const buyerOpen = (cases: CaseSummary[], name: string) =>
  cases.filter(
    (c) =>
      c.buyer === name &&
      needsResponse(c) &&
      !(c.due_at && Date.parse(c.due_at) < Date.now()),
  ).length;

export function CasePage({
  id,
  cases,
  onClose,
  onWritten,
  onAiDraft,
}: CasePageProps) {
  const s = useCase(id, { onWritten, onAiDraft });
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [id]);
  useEffect(() => {
    if (!s.pending) return;
    const box = panel.current?.querySelector<HTMLElement>(".confirm");
    box?.scrollIntoView({ block: "nearest" });
    box?.querySelector<HTMLButtonElement>("button.primary")?.focus();
  }, [s.pending]);
  useEffect(() => {
    if (s.scrollSeq)
      panel.current
        ?.querySelector("#rec")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [s.scrollSeq]);

  const a = s.analysis;
  const c = a?.case;
  const d = a?.decision ?? null;
  const amt = c ? money(c.amount_cents, c.currency) : "";
  const upd = c ? Date.parse(c.updated_at) : NaN;
  const status = !c
    ? ""
    : c.status === "UNDER_REVIEW" && upd
      ? "Under review"
      : c.status === "RESOLVED" || c.outcome
        ? `Closed ${upd ? dateShort(new Date(upd).toISOString()) : ""} · ${c.outcome === "RESOLVED_SELLER_FAVOUR" ? "Decided for you" : c.outcome === "RESOLVED_BUYER_FAVOUR" ? "Decided for the buyer" : "Resolved"}`
        : c.due_at
          ? `Response due ${dateShort(c.due_at)} (${inDays(c.due_at)}) · ${statusWords(c)}`
          : statusWords(c);
  const rb = c && needsResponse(c) ? buyerOpen(cases, c.buyer) : 0;
  const showRepeat =
    rb >= 3 && (s.fightAnyway || !d || d.call === "fight");

  // the sent response may already be on file as an OTHER evidence; it shows in its own block
  const draftText = (a?.draft.response ?? "").trim();
  const isSellerText = (n: string | undefined) =>
    !!n &&
    !!c &&
    (n.trim() === draftText ||
      c.messages.some(
        (m) => m.posted_by !== "BUYER" && m.content.includes(n.trim()),
      ));
  const evs = (c?.evidences ?? []).filter(
    (e) => !(e.evidence_type === "OTHER" && isSellerText(e.notes)),
  );
  const hidden = c?.evidences.find(
    (e) => e.evidence_type === "OTHER" && isSellerText(e.notes),
  );
  const noteSet = new Set(
    [...(c?.evidences ?? []).map((e) => e.notes), ...s.sentEvidence.map((e) => e.notes)]
      .map((n) => String(n ?? "").trim())
      .filter(Boolean),
  );
  const respText = (s.sentText ?? hidden?.notes ?? "").trim();
  const shownText = s.sentText ?? hidden?.notes ?? null;
  const showFight = !!c && s.isFight && needsResponse(c);

  return (
    <section id="panel" className="card" ref={panel}>
      <div className="panel-head">
        <div>
          <h2 id="panel-title">
            {c ? `${c.buyer} · ${reasonShort(c.reason)} · ${amt}` : "Loading..."}
          </h2>
          <p id="panel-sub" className="muted">
            {c && REASON_SHORT[c.reason] ? `${REASONS[c.reason]} · ` : ""}
            {status}
          </p>
        </div>
        <button id="close-panel" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {s.error && (
        <div id="panel-error" className="errbox">
          {s.error}
        </div>
      )}
      {a && c && (
        <div className="cols">
          <div>
            <h3>What the buyer said</h3>
            <div id="messages">
              {(() => {
                const out = c.messages.flatMap((m, i) => {
                  if (m.posted_by === "BUYER")
                    return [
                      <div className="msg" key={i}>
                        <b>Buyer</b>: {m.content}
                      </div>,
                    ];
                  const t = m.content.trim();
                  // once sent, the response and notes show in their own blocks
                  if (
                    s.done &&
                    (noteSet.has(t) || (respText && t.includes(respText)))
                  )
                    return [];
                  return [
                    <div className="msg" key={i}>
                      <b>You</b>: {m.content}
                    </div>,
                  ];
                });
                return out.length ? out : <p className="muted">No messages.</p>;
              })()}
            </div>
            <h3>Order</h3>
            <div id="items">
              {c.items.length ? (
                c.items.map((i, k) => (
                  <div className="msg" key={k}>
                    {i.item_quantity} × {i.item_description}
                  </div>
                ))
              ) : (
                <p className="muted">No items listed.</p>
              )}
            </div>
            <SentState text={shownText} />
            <EvidenceOnFile
              analysis={a}
              onFile={evs}
              sentEvidence={s.sentEvidence}
              vouched={s.vouched}
              added={s.added}
              sentText={s.sentText}
              sent={s.sentKind === "evidence"}
            />
          </div>
          <div>
            {showRepeat && (
              <p id="repeat" className="repeat">
                {c.buyer} has {rb} open disputes with you. Your response
                mentions the pattern; PayPal reviewers see it too.
              </p>
            )}
            <Recommendation
              decision={d}
              c={c}
              cost={s.cost}
              done={s.done}
              refunded={s.refunded}
              hidden={s.chose && !s.done}
            />
            <ShowTheMath
              key={id}
              analysis={a}
              cost={s.cost}
              inputs={s.inputs}
              onInput={s.setInput}
              onRecalc={() => void s.recompute(false)}
              hidden={s.done}
            />
            {showFight && (
              <div id="fightbox">
                <DraftEditor
                  value={s.draftText}
                  onChange={s.setDraft}
                  label={s.badge}
                  labelGreen={s.labelGreen}
                  dim={s.dim}
                  flagged={s.claims.length > 0}
                  note={s.draftNote}
                  claimNote={s.claims.length > 0}
                  fightNote={s.chose}
                />
                <Checklist
                  items={a.draft.checklist}
                  added={s.added}
                  onAdd={s.addEvidence}
                  onUndo={s.undo}
                />
              </div>
            )}
            <div id="actions" className="actions">
              {s.canAct &&
                (s.isFight ? (
                  <>
                    <button
                      className="primary"
                      type="button"
                      disabled={s.stillMissing.length > 0 || s.drafting || s.busy}
                      onClick={() => void s.act("evidence")}
                    >
                      Submit response to PayPal
                    </button>
                    {(s.stillMissing.length > 0 || s.drafting) && (
                      <span className="muted">
                        {s.drafting
                          ? "Updating the draft…"
                          : "Add the required evidence to submit"}
                      </span>
                    )}
                    <button
                      className={d?.call === "accept" ? "primary" : ""}
                      type="button"
                      disabled={s.busy}
                      onClick={() => void s.act("accept")}
                    >
                      Accept and refund {amt}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="primary"
                      type="button"
                      onClick={() => void s.act("accept")}
                    >
                      Accept and refund {amt}
                    </button>
                    <button type="button" onClick={s.setFightAnyway}>
                      Fight anyway
                    </button>
                  </>
                ))}
            </div>
            {s.pending && (
              <ConfirmSendBox
                kind={s.pending}
                text={
                  s.pending === "evidence"
                    ? s.confirmText
                    : `Refund ${amt} to ${c.buyer} and close the case?`
                }
                okLabel={s.pending === "evidence" ? "Send to PayPal" : "Refund"}
                claims={s.claims}
                onToggle={s.toggleClaim}
                onRecheck={() => void s.checkDraft()}
                onConfirm={() => void s.run()}
                onCancel={s.cancelConfirm}
                busy={s.busy}
              />
            )}
            <div id="action-result">
              {s.actionError && <div className="errbox">{s.actionError}</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
export default CasePage;
