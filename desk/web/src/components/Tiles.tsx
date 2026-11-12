import type { CaseSummary } from "../lib/api";
import { dayDiff, money, needsResponse } from "../lib/format";

const WON = "RESOLVED_SELLER_FAVOUR";
const isClosed = (c: CaseSummary) => c.status === "RESOLVED" || !!c.outcome;

export function Tiles({ cases }: { cases: CaseSummary[] }) {
  const open = cases.filter(needsResponse);
  const cur = open[0]?.currency ?? "USD";
  const sum = (f: (c: CaseSummary) => number) => open.reduce((t, c) => t + f(c), 0);
  const week = open.filter((c) => c.due_at && dayDiff(c.due_at) <= 7).length;
  const kept = open.filter((c) => c.keep_cents != null);
  const closed = cases.filter(isClosed);
  const won = closed.filter((c) => c.outcome === WON);
  return (
    <section className="tiles" aria-label="Summary">
      <div className="tile">
        <span className="k">Open disputes</span>
        <span className="v">{open.length}</span>
        <span className="s">{week} need you this week</span>
      </div>
      <div className="tile hot">
        <span className="k">Money at stake</span>
        <span className="v">{money(sum((c) => c.amount_cents), cur, true)}</span>
        <span className="s">across open disputes</span>
      </div>
      <div className="tile">
        <span className="k">Parley expects to keep</span>
        <span className="v">
          {kept.length ? money(kept.reduce((t, c) => t + (c.keep_cents ?? 0), 0), cur, true) : "—"}
        </span>
        <span className="s">
          of {money(sum((c) => c.amount_cents), cur, true)} at stake, if you follow every call
        </span>
      </div>
      <div className="tile">
        <span className="k">Won</span>
        <span className="v">
          {won.length} of {closed.length}
        </span>
        <span className="s">closed in your favour</span>
      </div>
    </section>
  );
}
