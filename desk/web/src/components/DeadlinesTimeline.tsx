import type { CaseSummary } from "../lib/api";
import { DAY, dateShort, dueSoon, inDays, money, needsResponse, rec } from "../lib/format";

const TICKS = [0, 1, 2, 3, 4, 5, 6, 7, 14, 21];

export function DeadlinesTimeline({
  cases,
  onOpen,
}: {
  cases: CaseSummary[];
  onOpen(id: string): void;
}) {
  const now = Date.now();
  const span = 21 * DAY;
  const lanes = new Map<number, number>();
  const open = cases
    .filter(
      (c): c is CaseSummary & { due_at: string } =>
        needsResponse(c) && !!c.due_at && Date.parse(c.due_at) - now <= span,
    )
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  return (
    <section className="card">
      <h2>Deadlines, next 21 days</h2>
      <div className="timeline">
        <div className="axis"></div>
        {TICKS.map((d) => (
          <div
            key={d}
            className={"tick" + (d % 7 === 0 ? " week" : "")}
            style={{ left: `${(d / 21) * 96 + 2}%` }}
          >
            {d === 0 ? "now" : `+${d}d`}
          </div>
        ))}
        {open.map((c) => {
          const left =
            Math.min(1, Math.max(0, (Date.parse(c.due_at) - now) / span)) * 96 + 2;
          const bucket = Math.round(left);
          const lane = lanes.get(bucket) ?? 0;
          lanes.set(bucket, lane + 1);
          const r = rec(c.call);
          return (
            <div
              key={c.dispute_id}
              className={`marker ${r.kind}${dueSoon(c) ? " soon" : ""}`}
              style={{ left: `${left}%`, top: `${40 - (lane % 3) * 14}px` }}
              title={`${c.buyer} · ${money(c.amount_cents, c.currency)} · due ${dateShort(c.due_at)} (${inDays(c.due_at)}) · ${r.label}`}
              onClick={() => onOpen(c.dispute_id)}
            />
          );
        })}
      </div>
      <div className="legend muted">
        Green fight · red accept · amber close call · grey not analysed
      </div>
    </section>
  );
}
