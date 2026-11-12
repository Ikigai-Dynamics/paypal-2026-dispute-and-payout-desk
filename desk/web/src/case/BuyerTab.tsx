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
  return (
    <div className="tabpanel">
      <dl className="facts">
        <div>
          <dt>Name</dt>
          <dd>{b.name ?? name}</dd>
        </div>
        <div>
          <dt>PayPal account</dt>
          <dd>{b.account_status ?? "Not shown"}</dd>
        </div>
        <div>
          <dt>Payer ID</dt>
          <dd className="mono">{b.payer_id ?? "Not shown"}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{b.email_masked ?? "Not shown"}</dd>
        </div>
        <div>
          <dt>Country</dt>
          <dd>{b.country ?? "Not shown"}</dd>
        </div>
        <div>
          <dt>Ships to</dt>
          <dd>{b.ship_to ? [b.ship_to.city, b.ship_to.state].filter(Boolean).join(", ") : "Not shown"}</dd>
        </div>
      </dl>
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
