import type { CaseView, Decision } from "../lib/api";
import { DAY, dateShort, money, pct, rec } from "../lib/format";

export function recSentence(d: Decision, c: CaseView, cost: number) {
  const cur = c.currency;
  const A = c.amount_cents;
  const cc = money(cost * 100, cur, true);
  const few = d.n < 3;
  const basis =
    d.n > 0 && !few
      ? ` (based on ${d.n} similar past case${d.n === 1 ? "" : "s"})`
      : "";
  if (d.call === "fight")
    return `${few ? `Rough estimate (few similar past cases): about ${pct(d.p)}% chance of keeping ${money(A, cur)}.` : `You have a ${pct(d.p)}% chance of keeping ${money(A, cur)}${basis}.`} Fighting costs about ${cc}; if you lose, you refund what you would refund anyway.`;
  return `${few ? `Rough estimate (few similar past cases): about ${pct(d.p)}% chance of keeping ${money(A, cur)}` : `Only a ${pct(d.p)}% chance of keeping ${money(A, cur)}${basis}`}, so fighting (about ${cc}) is unlikely to pay off. Refund it and close the case.`;
}

export function Recommendation({
  decision: d,
  c,
  cost,
  done,
  refunded,
  hidden,
}: {
  decision: Decision | null;
  c: CaseView;
  cost: number;
  done: boolean;
  refunded: boolean;
  hidden: boolean;
}) {
  if (done) {
    const upd = Date.parse(c.updated_at);
    const when = dateShort((upd || Date.now()) + 30 * DAY);
    return (
      <div id="rec" className="rec neutral" hidden={hidden}>
        {refunded ? (
          <div className="word">Refunded and closed</div>
        ) : (
          <>
            <div className="word">Response sent — waiting for PayPal</div>
            <div>PayPal usually decides by about {when}</div>
          </>
        )}
      </div>
    );
  }
  if (!d)
    return (
      <div id="rec" className="rec" hidden={hidden}>
        <div className="muted">
          No recommendation is available right now. You can still respond
          below.
        </div>
      </div>
    );
  const r = rec(d.call, d.marginal);
  return (
    <div id="rec" className={`rec ${r.kind}`} hidden={hidden}>
      <div className="word">
        {d.marginal
          ? `Close call: ${d.call}`
          : d.call === "fight"
            ? "Fight"
            : "Accept"}
      </div>
      <div>{recSentence(d, c, cost)}</div>
      {d.call === "fight" && d.p < 0.5 && (
        <div className="muted">
          {`Worth fighting even at ${pct(d.p)}%: if you lose, you refund ${money(c.amount_cents, c.currency)}, the same as accepting now; if you win, you keep it.${cost > 0 ? ` Fighting costs about ${money(cost * 100, c.currency, true)}.` : ""}`}
        </div>
      )}
    </div>
  );
}
export default Recommendation;
