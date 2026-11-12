import { useEffect, useState } from "react";
import { api, type BuyerInfo } from "../lib/api";

/** GET /api/cases/:id/buyer: only what PayPal lets a seller see; a 404 or a failure shows a plain note */
export function BuyerTab({ id, name }: { id: string; name: string }) {
  const [b, setB] = useState<BuyerInfo | "missing" | null>(null);
  useEffect(() => {
    let live = true;
    setB(null);
    api<BuyerInfo>(`/api/cases/${encodeURIComponent(id)}/buyer`).then(
      (r) => live && setB(r),
      () => live && setB("missing"),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (!b) return <p className="muted">Loading buyer details…</p>;
  if (b === "missing") return <p className="muted">Buyer details unavailable for this dispute.</p>;
  const more = (b.disputes_with_you ?? 0) > 1;
  const ship = b.ship_to ? [b.ship_to.city, b.ship_to.state].filter(Boolean).join(", ") : "";
  // a field PayPal did not share is left out, not printed as a blank
  const facts = (
    [
      ["Name", b.name ?? name],
      ["PayPal account", b.account_status],
      ["Payer ID", b.payer_id, true],
      ["Email", b.email_masked],
      ["Country", b.country],
      ["Ships to", ship],
    ] as [string, string | undefined, boolean?][]
  ).filter(([, v]) => !!v);
  return (
    <div className="tabpanel">
      {facts.length >= 2 ? (
        <dl className="facts">
          {facts.map(([k, v, mono]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={mono ? "mono" : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">PayPal shares little about this buyer.</p>
      )}
      <div className="reasons">
        <div className="reason">
          <span className="k">Orders with you</span>
          <span className="v">{b.orders_with_you ?? "—"}</span>
          {b.first_order_at?.slice(0, 10) && <small>first on {b.first_order_at?.slice(0, 10)}</small>}
        </div>
        <div className="reason">
          <span className="k">Disputes with you</span>
          <span className="v" style={{ color: more ? "var(--bad)" : "var(--ink)" }}>
            {b.disputes_with_you ?? "—"}
          </span>
          {b.disputes_with_you != null && <small>{more ? "more than most buyers" : "this is the first"}</small>}
        </div>
        {b.address_matches_delivery != null && (
          <div className="reason">
            <span className="k">Address match</span>
            <span className="v" style={{ color: b.address_matches_delivery ? "var(--good)" : "var(--warn)" }}>
              {b.address_matches_delivery ? "Matches delivery scan" : "Differs from scan"}
            </span>
          </div>
        )}
      </div>
      <small className="hint">
        From the dispute and your PayPal transaction history. PayPal doesn't share a buyer's public profile, so this is
        everything you're allowed to see.
      </small>
    </div>
  );
}
