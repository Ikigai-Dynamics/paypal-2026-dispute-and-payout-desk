import { useState } from "react";
import type { CaseSummary } from "../lib/api";
import {
  dateLong,
  dateShort,
  dueSoon,
  inDays,
  money,
  orderText,
  reasonWords,
  rec,
} from "../lib/format";
import { missedList, needing } from "../hooks/useCases";

export function CaseCards({
  cases,
  onOpen,
}: {
  cases: CaseSummary[];
  onOpen(id: string): void;
}) {
  const [showAll, setShowAll] = useState(false);
  const n = needing(cases);
  const shown = showAll ? n : n.slice(0, 6);
  const buyerOpen = (name: string) => n.filter((c) => c.buyer === name).length;
  const missed = missedList(cases);
  return (
    <section className="card">
      <h2>Disputes that need your response</h2>
      <div className="cards">
        {shown.length ? (
          shown.map((c) => {
            const r = rec(c.call);
            const ot = orderText(c);
            const rb = buyerOpen(c.buyer);
            const open = () => onOpen(c.dispute_id);
            return (
              <div
                key={c.dispute_id}
                className="dcard"
                tabIndex={0}
                role="button"
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                <span className="who">{c.buyer}</span>
                <span className="reason">{reasonWords(c.reason)}</span>
                {ot && <span className="reason">{ot}</span>}
                <span className="amt">{money(c.amount_cents, c.currency)}</span>
                <span className={"due" + (dueSoon(c) ? " soon" : "")}>
                  {c.due_at
                    ? `Due ${dateLong(c.due_at)} · ${inDays(c.due_at)}`
                    : "No due date"}
                </span>
                <span className={"pill " + r.color}>{r.label}</span>
                {rb >= 2 && (
                  <span className="pill amber">{rb} disputes from this buyer</span>
                )}
              </div>
            );
          })
        ) : (
          <p className="muted">Nothing needs your response right now.</p>
        )}
      </div>
      {n.length > 6 && (
        <p>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setShowAll(!showAll);
            }}
          >
            {showAll ? "Show fewer" : `Show all ${n.length}`}
          </a>
        </p>
      )}
      {missed.length > 0 && (
        <details className="missed">
          <summary>Missed deadline ({missed.length})</summary>
          {missed.map((c) => (
            <div key={c.dispute_id} className="m" onClick={() => onOpen(c.dispute_id)}>
              {c.buyer} · {money(c.amount_cents, c.currency)} · was due{" "}
              {dateShort(c.due_at!)}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
