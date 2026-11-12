import type { CaseSummary } from "../lib/api";
import { byDue, waitingList } from "../hooks/useCases";
import { callKind, afterSendWords, callWords, dayDiff, dueWords, money, needsResponse, reasonIcon, reasonShort } from "../lib/format";

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
  const week = open.filter((c) => c.due_at && dayDiff(c.due_at) <= 7);
  const later = open.filter((c) => !week.includes(c));
  const waiting = waitingList(cases);
  const row = (c: CaseSummary, wait = false) => {
    const on = lit?.includes(c.dispute_id);
    const k = callKind(c.call);
    return (
      <button
        key={c.dispute_id}
        type="button"
        role="listitem"
        className={"drow" + (wait ? " wait" : "") + (lit ? (on ? " lit" : " dim") : "")}
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
            {!wait && c.due_at ? ` · ${dueWords(dayDiff(c.due_at))}` : ""}
          </div>
        </span>
        <span className="r">
          <span className="amt">{money(c.amount_cents, c.currency)}</span>
          {wait ? (
            <span className="call wait">{afterSendWords(null, c)}</span>
          ) : (
            <span className={`call ${k ?? "none"}`}>{callWords(c)}</span>
          )}
        </span>
      </button>
    );
  };
  return (
    <div className="panel">
      <h2>Disputes that need you</h2>
      {lit && (
        <button type="button" className="chip on" onClick={onClearFilter}>
          Showing {lit.length} · show all
        </button>
      )}
      <div className="list" role="list">
        {open.length > 0 && (
          <div className="group-head">
            Due this week <span className="n">{week.length}</span>
          </div>
        )}
        {week.map((c) => row(c))}
        {!week.length && open.length > 0 && <p className="muted empty">Nothing is due this week.</p>}
        {!open.length && (
          <p className="muted empty">
            {loadError ? "Could not load your disputes." : cases.length ? "Nothing needs you right now." : "Loading your disputes…"}
          </p>
        )}
      </div>
      {later.length > 0 && (
        <details className="later">
          <summary>
            <span className="group-head">
              Later <span className="n">{later.length}</span>
            </span>
          </summary>
          <div className="list" role="list">
            {later.map((c) => row(c))}
          </div>
        </details>
      )}
      {waiting.length > 0 && (
        <div className="list" role="list" aria-label="Waiting on the buyer or PayPal">
          <div className="group-head">
            Waiting on the buyer or PayPal <span className="n">{waiting.length}</span>
          </div>
          {waiting.map((c) => row(c, true))}
        </div>
      )}
    </div>
  );
}
