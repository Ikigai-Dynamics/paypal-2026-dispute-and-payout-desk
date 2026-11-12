import { useEffect, useRef } from "react";
import type { ActivityCall, CaseSummary } from "../lib/api";
import {
  dayDiff,
  dueWords,
  money,
  needsResponse,
  reasonIcon,
  reasonWords,
  statusWords,
} from "../lib/format";
import { useCase } from "./useCase";
import { VerdictCard } from "./VerdictCard";
import { ShowTheMath } from "./ShowTheMath";
import { EvidenceOnFile } from "./EvidenceOnFile";
import { SentState } from "./SentState";
import { Checklist } from "./Checklist";
import { DraftEditor } from "./DraftEditor";
import { ConfirmSendBox } from "./ConfirmSendBox";
import { BuyerTab } from "./BuyerTab";
import { ActivityTab } from "./ActivityTab";

export type Tab = "evidence" | "buyer" | "draft" | "activity" | "math";
const TABS: [Tab, string][] = [
  ["evidence", "Evidence"],
  ["buyer", "Buyer"],
  ["draft", "Draft reply"],
  ["activity", "Activity"],
  ["math", "How Parley decided"],
];

export interface CasePanelProps {
  id: string;
  cases: CaseSummary[];
  calls: ActivityCall[] | null;
  tab: Tab;
  onTab(t: Tab): void;
  /** bumps when the chat asks to light up the missing evidence */
  highlight: number;
  onWritten(): Promise<void>;
  onAiDraft(): void;
}

const say = (text: string) => window.dispatchEvent(new CustomEvent("parley:say", { detail: { text } }));

export function CasePanel({ id, cases, calls, tab, onTab, highlight, onWritten, onAiDraft }: CasePanelProps) {
  const s = useCase(id, { onWritten, onAiDraft });
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // a case picked from below the fold (phone: the list is above) scrolls into view; the first one does not
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const r = panel.current?.getBoundingClientRect();
    if (r && (r.top < 0 || r.top > innerHeight * 0.6))
      panel.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [id]);
  useEffect(() => {
    if (s.pending)
      panel.current?.querySelector<HTMLElement>(".confirm")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [s.pending]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => {
      panel.current?.querySelectorAll<HTMLElement>(".checklist li.no").forEach((li) => {
        li.classList.remove("hl");
        void li.offsetWidth;
        li.classList.add("hl");
      });
    }, 60);
    return () => clearTimeout(t);
  }, [highlight]);
  useEffect(() => {
    if (s.sentKind === "offer") say("Offer sent through PayPal. I'll tell you when the buyer answers.");
    else if (s.sentKind === "evidence") say("Sent to PayPal. I'll watch for their answer.");
    else if (s.sentKind === "accept") say("Refunded and closed. Sometimes the short move is the smart one.");
  }, [s.sentKind]);

  const a = s.analysis;
  const c = a?.case;
  const d = a?.decision ?? null;
  const card = cases.find((x) => x.dispute_id === id);
  const cur = c?.currency ?? card?.currency ?? "USD";
  const amt = c ? money(c.amount_cents, c.currency) : card ? money(card.amount_cents, cur) : "";
  const left = (c?.due_at ?? card?.due_at) ? dayDiff((c?.due_at ?? card?.due_at)!) : null;
  const open = c ? needsResponse(c) && !s.sent : !!card && needsResponse(card);

  // the sent response may already be on file as an OTHER evidence; it shows in its own block
  const draftText = (a?.draft.response ?? "").trim();
  const isSellerText = (n: string | undefined) =>
    !!n &&
    !!c &&
    (n.trim() === draftText ||
      c.messages.some((m) => m.posted_by !== "BUYER" && m.content.includes(n.trim())));
  const evs = (c?.evidences ?? []).filter((e) => !(e.evidence_type === "OTHER" && isSellerText(e.notes)));
  const hidden = c?.evidences.find((e) => e.evidence_type === "OTHER" && isSellerText(e.notes));
  const shownText = s.sentText ?? hidden?.notes ?? null;

  const offerCall = (cents: number) =>
    `POST /v1/customer/disputes/${id}/make-offer {"offer_amount": {"currency_code": "${cur}", "value": "${(cents / 100).toFixed(2)}"}, "offer_type": "REFUND"}`;

  const body = () => {
    if (!a || !c) return <p className="muted">Loading this dispute…</p>;
    if (tab === "buyer") return <BuyerTab id={id} name={c.buyer} />;
    if (tab === "activity") return <ActivityTab id={id} calls={calls} decision={d} currency={cur} />;
    if (tab === "math") return <ShowTheMath analysis={a} cost={s.cost} />;
    if (tab === "draft")
      return (
        <div className="tabpanel">
          <SentState text={shownText} />
          {s.canAct && !s.isFight && (
            <>
              <p className="note">
                Parley would not fight this one. If you want to anyway, it will write the strongest reply it can.
              </p>
              <div className="actions">
                <button type="button" className="btn" onClick={s.setFightAnyway}>
                  Fight anyway
                </button>
              </div>
            </>
          )}
          {s.canAct && s.isFight && (
            <>
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
                newDraft={!!s.newDraft}
                onUseNewDraft={s.useNewDraft}
              />
              <div className="actions">
                <button
                  className="btn primary"
                  type="button"
                  disabled={s.stillMissing.length > 0 || s.drafting || s.busy}
                  onClick={() => void s.act("evidence")}
                >
                  Send reply to PayPal
                </button>
                {(s.stillMissing.length > 0 || s.drafting) && (
                  <span className="muted">
                    {s.drafting ? "Updating the draft…" : "Add the required evidence first (Evidence tab)"}
                  </span>
                )}
              </div>
            </>
          )}
          {!s.canAct && !shownText && <p className="muted">No reply is waiting on this dispute.</p>}
        </div>
      );
    const offerBuyer = c.messages.filter((m) => m.posted_by === "BUYER");
    return (
      <div className="tabpanel">
        {s.canAct ? (
          <Checklist items={a.draft.checklist} added={s.added} onAdd={s.addEvidence} onUndo={s.undo} />
        ) : (
          <ul className="checklist">
            {a.draft.checklist.map((i) => (
              <li key={i.item} className={i.status === "missing" ? "no" : "ok"}>
                <span className="ico">{i.status === "missing" ? "✗" : "✓"}</span>
                <b>{i.item}</b>
                <span className="why">{i.why}</span>
              </li>
            ))}
          </ul>
        )}
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
        {offerBuyer.length > 0 && (
          <>
            <h3>What the buyer said</h3>
            {offerBuyer.map((m, i) => (
              <div className="note" key={i}>
                “{m.content}”
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="panel" ref={panel} aria-live="polite">
      <div className="case-head">
        <h2 className="title">
          {card || c ? `${reasonIcon((c ?? card)!.reason)} ${card?.item ?? c?.items[0]?.item_description ?? `Order from ${(c ?? card)!.buyer}`}` : "Loading…"}
        </h2>
        {open && left != null && (
          <span className={"due" + (left <= 3 ? " urgent" : "")}>
            {left < 0 ? "Overdue" : dueWords(left, "Respond")}
          </span>
        )}
        {!open && c && <span className="due">{s.sent ? "Done" : statusWords(c)}</span>}
      </div>
      {s.error && <div className="errbox">{s.error}</div>}
      {(c ?? card) && (
        <dl className="facts">
          <div>
            <dt>Buyer says</dt>
            <dd>{reasonWords((c ?? card)!.reason)}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{amt}</dd>
          </div>
          <div>
            <dt>Buyer</dt>
            <dd>
              <button type="button" className="link" onClick={() => onTab("buyer")}>
                {(c ?? card)!.buyer} ›
              </button>
            </dd>
          </div>
          <div>
            <dt>Case</dt>
            <dd className="mono">{id}</dd>
          </div>
        </dl>
      )}
      {a && c && (
        <VerdictCard
          decision={d}
          amountCents={c.amount_cents}
          currency={cur}
          precedents={a.precedents}
          checklist={a.draft.checklist}
          canAct={s.canAct}
          fightAnyway={s.fightAnyway}
          busy={s.busy || !!s.pending}
          sent={s.sent}
          onOffer={(cents) => void s.act("offer", cents)}
          onFight={() => {
            s.setFightAnyway();
            onTab("draft");
            say("Your call. I'll still help you write the strongest reply I can.");
          }}
          onReview={() => onTab("draft")}
          onRefund={() => void s.act("accept")}
        />
      )}
      {c && s.pending && (
        <ConfirmSendBox
          kind={s.pending}
          text={
            s.pending === "evidence"
              ? s.confirmText
              : s.pending === "offer"
                ? `Offer ${money(s.offerCents, cur)} back to ${c.buyer} through PayPal?`
                : `Refund ${amt} to ${c.buyer} and close the case?`
          }
          call={s.pending === "offer" ? offerCall(s.offerCents) : undefined}
          okLabel={s.pending === "evidence" ? "Send to PayPal" : s.pending === "offer" ? "Send offer" : "Refund"}
          claims={s.claims}
          onToggle={s.toggleClaim}
          onRecheck={() => void s.checkDraft()}
          onConfirm={() => void s.run()}
          onCancel={s.cancelConfirm}
          busy={s.busy}
        />
      )}
      {s.actionError && <div className="errbox">{s.actionError}</div>}
      <div className="tabs" role="tablist" aria-label="About this dispute">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls="tabbody"
            onClick={() => onTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      <div id="tabbody" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {body()}
      </div>
    </div>
  );
}
export default CasePanel;
