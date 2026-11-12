import type { CaseSummary } from "../lib/api";
import { callKind, dayDiff, dueWords, money, needsResponse } from "../lib/format";

const DAYS = 14;

/** Response deadlines for the next 14 days: each open dispute is a dot on its due day */
export function DeadlinesTimeline({
  cases,
  onOpen,
  selectedId,
}: {
  cases: CaseSummary[];
  onOpen(id: string): void;
  selectedId?: string | null;
}) {
  const open = cases.filter((c) => needsResponse(c) && c.due_at);
  // an overdue case sits on today
  const on = (i: number) => open.filter((c) => Math.max(0, dayDiff(c.due_at!)) === i);
  return (
    <section className="strip" aria-label="Deadlines">
      <h2>Response deadlines · next 14 days</h2>
      <div className="days">
        {Array.from({ length: DAYS }, (_, i) => {
          const hits = on(i);
          return (
            <div
              key={i}
              className={"day" + (hits.length ? " has" : "") + (hits.length && i <= 3 ? " urgent" : "")}
            >
              <span className="lbl">{i === 0 ? "today" : `+${i}`}</span>
              <span className="chips2">
                {hits.map((c) => (
                  <button
                    key={c.dispute_id}
                    type="button"
                    className={`dd ${callKind(c.call) ?? ""}`}
                    aria-current={c.dispute_id === selectedId}
                    aria-label={`${c.item ?? c.buyer}, ${money(c.amount_cents, c.currency)}, ${dueWords(dayDiff(c.due_at!))}`}
                    title={`${c.item ?? c.buyer}: ${dueWords(dayDiff(c.due_at!))}`}
                    onClick={() => onOpen(c.dispute_id)}
                  />
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
