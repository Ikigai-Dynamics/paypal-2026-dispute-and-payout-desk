import type { CaseSummary, Info, Summary } from "../lib/api";
import { dueSoon, money, rec } from "../lib/format";
import { bucketLine, needing, urgentCase } from "../hooks/useCases";

const ENV: Record<string, string> = {
  sandbox: "PayPal Sandbox",
  mock: "PayPal test data",
};

export function SituationHeader({
  info,
  aiOn,
  cases,
  summary,
  loadError,
  onOpen,
}: {
  info: Info | null;
  aiOn: boolean;
  cases: CaseSummary[];
  summary: Summary | null;
  loadError: boolean;
  onOpen(id: string): void;
}) {
  const n = needing(cases);
  const soon = n.filter(dueSoon).length;
  const cur = summary?.currency ?? "USD";
  const stake =
    summary?.at_stake_cents ??
    n.filter((c) => c.currency === cur).reduce((t, c) => t + c.amount_cents, 0);
  const f = n.filter((c) => rec(c.call).base === "fight").length;
  const a = n.filter((c) => rec(c.call).base === "accept").length;
  const need = summary?.needs_response ?? n.length;
  const situation = loadError
    ? "Could not load your disputes. Try again."
    : !cases.length && !summary
      ? "Loading your disputes..."
      : `${
          summary
            ? `${summary.total} disputes this month: ${bucketLine(summary)}`
            : `${need} need${need !== 1 ? "" : "s"} your response`
        } · ${soon} due in the next 3 days · ${money(stake, cur)} at stake · Recommended: fight ${f}, accept ${a}`;
  const first = n[0];
  const fightable = urgentCase(cases);
  const env = info ? ENV[info.paypalEnv] : undefined;
  return (
    <header className="card head">
      <div className="title-row">
        <h1>Dispute and Payout Desk</h1>
        {env && <span className="pill grey">{env}</span>}
        {info && (
          <span className={"pill " + (aiOn ? "green" : "grey")}>
            {aiOn ? "AI drafting on" : "AI offline: template drafts"}
          </span>
        )}
      </div>
      <p className="story">
        PayPal disputes come in; the desk recommends fight or accept for each,
        drafts your response with AI, and sends it to PayPal when you confirm.
      </p>
      <p className="situation">{situation}</p>
      <button
        className="primary"
        disabled={!n.length}
        onClick={() => {
          const c = fightable ?? first;
          if (c) onOpen(c.dispute_id);
        }}
      >
        {fightable
          ? "Fight the most urgent dispute"
          : "Start with the most urgent case"}
      </button>
      {first && fightable && first !== fightable && (
        <p className="muted">
          {first.buyer} is due first but is an Accept; opening {fightable.buyer}
        </p>
      )}
    </header>
  );
}
