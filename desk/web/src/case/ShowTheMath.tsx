import type { Analysis } from "../lib/api";
import { money, pct, reasonWords, signed, unbracket } from "../lib/format";

type Inputs = { prior: string; c: string; fee: string };

export function ShowTheMath({
  analysis: a,
  cost,
  inputs,
  onInput,
  onRecalc,
  hidden,
}: {
  analysis: Analysis;
  cost: number;
  inputs: Inputs;
  onInput(k: keyof Inputs, v: string): void;
  onRecalc(): void;
  hidden: boolean;
}) {
  const c = a.case;
  const d = a.decision;
  const cur = c.currency;
  const rows = d
    ? [
        ["Win chance", `${pct(d.p)}%`],
        ["Amount at stake", money(c.amount_cents, cur)],
        ["Cost to fight", money(cost * 100, cur)],
        ["Expected value of fighting", signed(d.ev_fight_cents, cur)],
        ["Expected value of refunding", signed(d.ev_accept_cents, cur)],
      ]
    : [];
  const kind =
    c.reason === "OTHER"
      ? "disputes where the buyer gave no reason"
      : `${reasonWords(c.reason).toLowerCase()} disputes`;
  const won = d && Number.isFinite(d.wins) ? ` (${d.wins} won)` : "";
  const p0line = !d
    ? ""
    : d.n > 0
      ? `Sellers win about ${pct(d.p0)}% of ${kind} on average. Your ${d.n} similar past case${d.n === 1 ? "" : "s"}${won} ${pct(d.p) < pct(d.p0) ? "lower" : "raise"} your chance to ${pct(d.p)}%.`
      : `About ${pct(d.p0)}% of ${kind} are won by sellers; with no similar past cases, your chance stays at ${pct(d.p)}%.`;
  const precs = new Map<string, { p: Analysis["precedents"][number]; n: number }>();
  for (const p of a.precedents.filter((p) => p.outcome != null)) {
    const k = `${p.won}|${unbracket(p.snippet)}`;
    precs.set(k, { p, n: (precs.get(k)?.n ?? 0) + 1 });
  }
  return (
    <details id="math" hidden={hidden}>
      <summary>Show the math</summary>
      <p id="explanation">{a.draft.explanation ?? ""}</p>
      <dl id="terms-list" className="terms">
        {rows.map(([k, v]) => (
          <Row key={k} k={k!} v={v!} />
        ))}
      </dl>
      <p id="p0line" className="muted">
        {p0line}
      </p>
      <details className="formula">
        <summary>Formula</summary>
        <pre id="terms">{d ? d.terms.join("\n") : ""}</pre>
      </details>
      <h4>Similar past cases</h4>
      <div id="precedents">
        {precs.size ? (
          <table className="prec">
            <tbody>
              <tr>
                <th>Outcome</th>
                <th>Snippet</th>
              </tr>
              {[...precs.entries()].map(([k, { p, n }]) => (
                <tr key={k}>
                  <td>
                    {p.won ? "You won" : "Buyer won"}
                    {n > 1 ? ` · ${n} cases` : ""}
                  </td>
                  <td>{unbracket(p.snippet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No similar resolved cases yet.</p>
        )}
      </div>
      <div className="inputs">
        <label>
          Win chance override (%){" "}
          <input
            id="in-prior"
            inputMode="decimal"
            placeholder="use the estimate"
            size={8}
            value={inputs.prior}
            onChange={(e) => onInput("prior", e.target.value)}
          />
        </label>
        <label>
          Cost to fight{" "}
          <input
            id="in-c"
            inputMode="decimal"
            size={6}
            value={inputs.c}
            onChange={(e) => onInput("c", e.target.value)}
          />
          <span className="hint">your time and handling</span>
        </label>
        <label>
          Extra fee if you lose{" "}
          <input
            id="in-fee"
            inputMode="decimal"
            size={6}
            value={inputs.fee}
            onChange={(e) => onInput("fee", e.target.value)}
          />
        </label>
        <button id="recompute" type="button" onClick={onRecalc}>
          Recalculate
        </button>
      </div>
    </details>
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
