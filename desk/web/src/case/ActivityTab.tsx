import type { ActivityCall, Decision } from "../lib/api";
import { callWords } from "../lib/format";
import { callLabel } from "../components/PayPalFooter";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
  const mine = (calls ?? []).filter((x) => x.dispute_id === id);
  return (
    <ul className="tl">
      {mine.map((x) => (
        <li key={x.at + x.path}>
          {callLabel(x)} ·{" "}
          <span className={x.status < 400 ? "s-ok" : "s-bad"}>{x.status < 400 ? "ok" : `failed ${x.status}`}</span>
          <br />
          <small>{when(x.at)} · PayPal call</small>
        </li>
      ))}
      {decision && (
        <li>
          Parley's call:{" "}
          {callWords({ call: decision.call, offer_cents: decision.offer?.amount_cents, currency })}
          <br />
          <small>{decision.n} similar past cases · decided by the desk's core</small>
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
