import type { CaseSummary } from "../lib/api";
import { byDue } from "../hooks/useCases";
import { callKind, callWords, dayDiff, dueWords, money, needsResponse, reasonIcon, reasonShort } from "../lib/format";

/** "Disputes that need you": one row per open dispute with Parley's call. `lit` (from the chat) dims the rest. */
export function DisputeList({
  cases,
  selectedId,
  lit,
  onOpen,
  onClearFilter,
  loadError,
}: {
  cases: CaseSummary[];
  selectedId: string | null;
  lit: string[] | null;
  onOpen(id: string): void;
  onClearFilter(): void;
  loadError?: boolean;
}) {
  const open = cases.filter(needsResponse).sort(byDue);
  return (
    <div className="panel">
      <h2>Disputes that need you</h2>
      {lit && (
        <button type="button" className="chip on" onClick={onClearFilter}>
          Showing {lit.length} · show all
        </button>
      )}
      <div className="list" role="list">
        {open.map((c) => {
          const on = lit?.includes(c.dispute_id);
          const k = callKind(c.call);
          return (
            <button
              key={c.dispute_id}
              type="button"
              role="listitem"
              className={"drow" + (lit ? (on ? " lit" : " dim") : "")}
              aria-current={c.dispute_id === selectedId}
              onClick={() => onOpen(c.dispute_id)}
            >
              <span className="dico" style={{ background: c.dispute_id === selectedId ? "var(--card)" : "var(--bg)" }}>
                {reasonIcon(c.reason)}
              </span>
              <span style={{ minWidth: 0 }}>
                <div className="t">{c.item ?? `Order from ${c.buyer}`}</div>
                <div className="m">
                  {reasonShort(c.reason)}
                  {c.due_at ? ` · ${dueWords(dayDiff(c.due_at))}` : ""}
                </div>
              </span>
              <span className="r">
                <span className="amt">{money(c.amount_cents, c.currency)}</span>
                <span className={`call ${k ?? "none"}`}>{callWords(c)}</span>
              </span>
            </button>
          );
        })}
        {!open.length && (
          <p className="muted empty">
            {loadError ? "Could not load your disputes." : cases.length ? "Nothing needs you right now." : "Loading your disputes…"}
          </p>
        )}
      </div>
    </div>
  );
}
