import { useEffect, useState } from "react";
import { api, type Analysis, type Assumption } from "../lib/api";
import { money, pct, reasonWords, signed } from "../lib/format";

const words = (id: string) => id.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

/** An assumption's value in the units a seller reads: dollars, percents or plain numbers. */
const valueOf = (x: Assumption, cur: string) => {
  const v = Number(x.value);
  if (!Number.isFinite(v)) return String(x.value);
  if (x.unit === "cents") return money(v, cur);
  if (x.unit === "probability" || x.unit === "share of amount") return `${pct(v)}%`;
  return `${v}${x.unit ? ` ${x.unit}` : ""}`;
};

/** "How Parley decided": the only place with the math, in plain terms */
export function ShowTheMath({ analysis: a, cost }: { analysis: Analysis; cost: number }) {
  const c = a.case;
  const d = a.decision;
  const cur = c.currency;
  const [fetched, setFetched] = useState<Assumption[] | null>(null);
  const given = d?.assumptions;
  useEffect(() => {
    if (given?.length) return;
    let live = true;
    api<{ assumptions: Assumption[] } | Assumption[]>("/api/assumptions").then(
      (r) => live && setFetched(Array.isArray(r) ? r : (r.assumptions ?? [])),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [given?.length]);
  const assumptions = given?.length ? given : fetched;
  if (!d) return <p className="muted">There is no calculation for this dispute right now.</p>;
  const interval = d.p_lo != null && d.p_hi != null ? ` (likely ${pct(d.p_lo)}–${pct(d.p_hi)}%)` : "";
  const fightCost = cost * 100 + (d.ai_cost_cents ?? 0);
  const rows = [
    ["Win chance", `${pct(d.p)}%${interval}, estimated`],
    ["Amount at stake", money(c.amount_cents, cur)],
    ["Cost to fight", money(Math.round(fightCost), cur)],
    ["Fighting, on average", signed(d.ev_fight_cents, cur)],
    ["Refunding in full", signed(d.ev_accept_cents, cur)],
    ...(d.offer
      ? [["Best offer", `${money(d.offer.amount_cents, cur)}, taken ${pct(d.offer.q)}% of the time: ${signed(d.offer.ev_cents, cur)}`]]
      : []),
  ];
  const kind =
    c.reason === "OTHER"
      ? "disputes where the buyer gave no reason"
      : `${reasonWords(c.reason).toLowerCase()} disputes`;
  const p0line =
    d.n > 0
      ? `Sellers win about ${pct(d.p0)}% of ${kind} on average. Your ${d.n} similar past case${d.n === 1 ? "" : "s"}${Number.isFinite(d.wins) ? ` (${d.wins} won)` : ""} ${d.n === 1 ? "moves" : "move"} your chance to ${pct(d.p)}%.`
      : `About ${pct(d.p0)}% of ${kind} are won by sellers; with no similar past cases, your chance stays at ${pct(d.p)}%.`;
  const precs = new Map<string, { p: Analysis["precedents"][number]; n: number }>();
  for (const p of a.precedents.filter((p) => p.outcome != null)) {
    const k = String(p.won);
    precs.set(k, { p, n: (precs.get(k)?.n ?? 0) + 1 });
  }
  return (
    <div className="tabpanel mathtab">
      <p className="muted">For the curious. Same numbers every time; the AI only writes the reply.</p>
      <p>{a.draft.explanation ?? ""}</p>
      <dl className="terms">
        {rows.map(([k, v]) => (
          <Row key={k} k={k!} v={v!} />
        ))}
      </dl>
      <p className="muted">{p0line}</p>
      {d.offer && (
        <p className="muted">Every offer from $0.50 up to the full amount was checked in 50¢ steps; this one pays best.</p>
      )}
      {d.ai_cost_cents != null && (
        <p className="muted">AI cost on this case so far: {money(d.ai_cost_cents, cur)}, counted in the cost to fight.</p>
      )}
      <details>
        <summary>The working</summary>
        <pre>{d.terms.join("\n")}</pre>
      </details>
      <h3>Similar past cases</h3>
      {precs.size ? (
        <table className="prec">
          <tbody>
            <tr>
              <th>Outcome</th>
              <th>Dispute type</th>
            </tr>
            {[...precs.entries()].map(([k, { p, n }]) => (
              <tr key={k}>
                <td>
                  {p.won ? "You won" : "Buyer won"}
                  {n > 1 ? ` · ${n} cases` : ""}
                </td>
                <td>{reasonWords(c.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No similar resolved cases yet.</p>
      )}
      {!!assumptions?.length && (
        <>
          <h3>Assumptions Parley makes</h3>
          <table className="prec">
            <tbody>
              <tr>
                <th>Assumption</th>
                <th>Value</th>
                <th>Source</th>
              </tr>
              {assumptions.map((x) => (
                <tr key={x.id}>
                  <td>{x.label ?? words(x.id)}</td>
                  <td>{valueOf(x, cur)}</td>
                  <td>{x.source?.startsWith("Parley's starting table") ? "Parley's starting table" : (x.source ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
// a dl row; dt and dd keep the two-column grid in app.css
const Row = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </>
);
export default ShowTheMath;
