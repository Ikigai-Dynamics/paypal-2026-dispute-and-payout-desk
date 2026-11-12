import { useState } from "react";
import { api, type ActivityCall, type Decision, type DecisionRecord } from "../lib/api";
import "../components/trust.css";
import { callWords } from "../lib/format";
import { callLabel } from "../components/PayPalFooter";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** the decision core's request and answer for one case, with copy buttons for the JSON and a ready-to-run curl */
function DecisionRecordBox({ id }: { id: string }) {
  const [rec, setRec] = useState<DecisionRecord | null>(null);
  const [err, setErr] = useState(false);
  const [done, setDone] = useState("");
  const load = () => {
    if (!rec)
      api<DecisionRecord>(`/api/cases/${encodeURIComponent(id)}/decision`).then(setRec, () => setErr(true));
  };
  const json = rec ? JSON.stringify(rec, null, 2) : "";
  const curl = rec
    ? `curl -X POST ${location.origin}/api/decide -H 'content-type: application/json' -d '${JSON.stringify(rec.request).replace(/'/g, "'\\''")}'`
    : "";
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(what);
      setTimeout(() => setDone(""), 2000);
    } catch {
      setDone("Copy blocked by the browser");
    }
  };
  return (
    <details className="record" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>Decision record</summary>
      {err && <p className="muted">The decision record is not available right now.</p>}
      {rec && (
        <>
          <p className="muted">
            Decision core {rec.core.contract} · build {rec.core.version}
          </p>
          <div className="btns">
            <button type="button" className="chip" onClick={() => copy("Copied JSON", json)}>
              Copy JSON
            </button>
            <button type="button" className="chip" onClick={() => copy("Copied curl", curl)}>
              Copy as curl
            </button>
            <span className="muted" role="status">
              {done}
            </span>
          </div>
          <pre className="json" tabIndex={0}>
            {json}
          </pre>
        </>
      )}
    </details>
  );
}

type Entry = ActivityCall & { kind?: string; note?: string | null };
// entries Parley writes itself ("AI drafted reply ($0.03)", "You approved: ...") carry their text in `note`
const ownIcon = (x: Entry) =>
  /draft/i.test(`${x.kind} ${x.note}`) ? "✎" : /approv/i.test(`${x.kind} ${x.note}`) ? "✔" : x.kind === "webhook" ? "↩" : null;

/** this case's PayPal calls (newest first) and Parley's own events */
export function ActivityTab({
  id,
  calls,
  decision,
  currency,
}: {
  id: string;
  calls: ActivityCall[] | null;
  decision: Decision | null;
  currency: string;
}) {
  const mine = (calls ?? []).filter((x) => x.dispute_id === id) as Entry[];
  return (
    <ul className="tl">
      {mine.map((x) =>
        x.kind && x.kind !== "paypal" && x.kind !== "webhook" ? (
          <li key={x.at + x.path}>
            <span aria-hidden="true">{ownIcon(x) ?? "•"} </span>
            {x.note || x.path}
            <br />
            <small>{when(x.at)} · Parley</small>
          </li>
        ) : (
        <li key={x.at + x.path}>
          {ownIcon(x) && <span aria-hidden="true">{ownIcon(x)} </span>}
          {callLabel(x)} ·{" "}
          <span className={x.status < 400 ? "s-ok" : "s-bad"}>{x.status < 400 ? "ok" : `failed ${x.status}`}</span>
          <br />
          <small>{when(x.at)} · {x.kind === "webhook" ? "PayPal event" : "PayPal call"}</small>
        </li>
        ),
      )}
      {decision && (
        <li>
          Parley's call:{" "}
          {callWords({ call: decision.call, offer_cents: decision.offer?.amount_cents, currency })}
          <br />
          <small>{decision.n} similar past case{decision.n === 1 ? "" : "s"} · Parley's call</small>
        </li>
      )}
      {decision && (
        <li>
          <DecisionRecordBox id={id} />
        </li>
      )}
      {!mine.length && !decision && <li>Nothing has happened on this dispute yet.</li>}
      {calls === null && (
        <li>
          <small>The PayPal call log is not reachable right now.</small>
        </li>
      )}
    </ul>
  );
}
