import type { ChecklistItem, Decision, Precedent } from "../lib/api";
import { callKind, money, pct, type CallKind } from "../lib/format";

type Props = {
  decision: Decision | null;
  amountCents: number;
  currency: string;
  precedents: Precedent[];
  checklist: ChecklistItem[];
  /** the seller can still act on this case */
  canAct: boolean;
  /** the seller chose to fight against Parley's call */
  fightAnyway: boolean;
  /** a write is in flight or waiting for its confirm */
  busy: boolean;
  sent: string | null;
  onOffer(cents: number): void;
  onFight(): void;
  onReview(): void;
  onRefund(): void;
};

export function verdictOf(d: Decision | null): { kind: CallKind | null; offer: number | null } {
  const kind = callKind(d?.call);
  const offer = d?.offer?.amount_cents ?? null;
  // an offer call with no amount cannot be sent: fall back to the nearest plain call
  return { kind: kind === "offer" && !offer ? "fight" : kind, offer };
}

export function strengthOf(items: ChecklistItem[]) {
  const have = items.length ? items.filter((i) => i.status !== "missing").length / items.length : 0;
  return have >= 0.8
    ? { word: "Strong", color: "var(--good)", share: have }
    : have >= 0.5
      ? { word: "Decent", color: "var(--warn)", share: have }
      : { word: "Thin", color: "var(--bad)", share: have };
}

export function VerdictCard(p: Props) {
  const d = p.decision;
  const { kind, offer } = verdictOf(d);
  const cur = p.currency;
  const $ = (c: number) => money(c, cur);
  if (!d || !kind)
    return (
      <div className="verdict">
        <p className="why">Parley has no call on this one yet. You can still write a reply in the Draft reply tab.</p>
      </div>
    );
  const what = kind === "offer" ? `Offer ${$(offer!)} back` : kind === "fight" ? "Fight it" : `Refund ${$(p.amountCents)} in full`;
  const interval = d.p_lo != null && d.p_hi != null ? ` (${pct(d.p_lo)}–${pct(d.p_hi)}%)` : "";
  const evOf = d.offer?.ev_cents;
  const why =
    kind === "offer"
      ? `${d.offer && d.offer.q > 0 ? `A ${pct(d.offer.q)}% chance they take it. ` : ""}${evOf != null && evOf - d.ev_fight_cents > 0 ? `On average you keep ${$(evOf - d.ev_fight_cents)} more than fighting.` : "On average it beats both fighting and a full refund."}`
      : kind === "fight"
        ? d.ev_fight_cents - d.ev_accept_cents > 0
          ? `You'd likely do better by fighting: about ${$(d.ev_fight_cents - d.ev_accept_cents)} more than a full refund, on average.`
          : "Fighting is worth a try on these numbers."
        : "Fighting costs more than the refund on average. Close it and move on.";
  const prec = p.precedents.filter((x) => x.outcome != null);
  const won = prec.filter((x) => x.won).length;
  const ev = strengthOf(p.checklist);
  const keep = d.keep_cents;
  const act = p.canAct && !p.sent;
  const fightLabel = p.fightAnyway ? "Review my reply" : "Fight anyway";
  return (
    <div className="verdict">
      <div className="top">
        <span className="what">Parley says: {what}</span>
        <span className="chip-p">
          {pct(d.p)}%{interval} estimated chance to win
        </span>
      </div>
      <p className="why">{why}</p>
      {d.buyer_flag && d.buyer_disputes != null && d.buyer_disputes >= 3 && (
        <p className="why">
          {d.buyer_orders != null && d.buyer_orders >= d.buyer_disputes
            ? `Buyer has disputed ${d.buyer_disputes} of ${d.buyer_orders} orders with you`
            : `Buyer has ${d.buyer_disputes} disputes with you`}
          : Parley would not offer a partial refund.
        </p>
      )}
      <div className="reasons">
        <div className="reason">
          <span className="k">Cases like this</span>
          <span className="v">{prec.length ? `${won} of ${prec.length} won` : "None yet"}</span>
          <div className="dots">
            {prec.slice(0, 24).map((x, i) => (
              <span key={i} className={"pdot " + (x.won ? "w" : "l")} title={x.won ? "won" : "lost"} />
            ))}
          </div>
        </div>
        <div className="reason">
          <span className="k">Your evidence</span>
          <span className="v" style={{ color: ev.color }}>
            {ev.word}
          </span>
          <div className="meter">
            <i style={{ width: `${ev.share * 100}%`, background: ev.color }} />
          </div>
        </div>
        <div className="reason">
          <span className="k">You'd likely keep</span>
          <span className="v">{keep != null ? $(keep) : "—"}</span>
          <small>of {$(p.amountCents)} at stake</small>
        </div>
      </div>
      {p.sent && (
        <div className="sentbox" role="status">
          {p.sent}
        </div>
      )}
      {act && (
        <div className="btns">
          {kind === "offer" ? (
            <button type="button" className="btn primary" disabled={p.busy} onClick={() => p.onOffer(offer!)}>
              Send {$(offer!)} offer
            </button>
          ) : kind === "fight" ? (
            <button type="button" className="btn primary" onClick={p.onReview}>
              Review my reply
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={p.busy} onClick={p.onRefund}>
              Refund in full
            </button>
          )}
          {kind !== "fight" && (
            <button type="button" className="btn" onClick={p.onFight}>
              {fightLabel}
            </button>
          )}
          {kind !== "offer" && offer != null && (
            <button type="button" className="btn" disabled={p.busy} onClick={() => p.onOffer(offer)}>
              Offer {$(offer)} instead
            </button>
          )}
          {kind !== "accept" && (
            <button type="button" className="btn quiet" disabled={p.busy} onClick={p.onRefund}>
              Refund in full
            </button>
          )}
        </div>
      )}
    </div>
  );
}
