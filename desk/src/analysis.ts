import type { Llm } from "@jeirslab/llm-client";
import {
  buildDecideRequest,
  callDecide,
  type DecideOptions,
} from "./decide-client.js";
import type { PgStore } from "./db.js";
import { draftResponse } from "./draft.js";
import type { CaseRow, CaseView, Decision, Draft, Precedent } from "./types.js";

const STOP = new Set(
  "the a an and or of to in on for with is it was my i we you that this have has not no but be are were from at as by me our your they their them its been had".split(
    " ",
  ),
);

/** Top terms of a case's search text, as a to_tsquery OR expression. Safe characters only. */
export function topTermsQuery(text: string, max = 12): string {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const terms = [...freq.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1),
    )
    .slice(0, max)
    .map(([w]) => w);
  return terms.length ? terms.join(" | ") : "dispute";
}

export const SELLER_FAVOUR = "RESOLVED_SELLER_FAVOUR";
export const toPrecedent = (r: {
  dispute_id: string;
  outcome: string;
  amount_cents: number;
  snippet: string;
}): Precedent => ({ ...r, won: r.outcome === SELLER_FAVOUR });

export function toView(row: CaseRow, now = Date.now()): CaseView {
  const items = row.raw.disputed_transactions.flatMap((t) => t.items ?? []);
  return {
    dispute_id: row.dispute_id,
    reason: row.reason,
    stage: row.stage,
    status: row.status,
    outcome: row.outcome,
    amount_cents: row.amount_cents,
    currency: row.currency,
    buyer: row.buyer,
    merchant: row.raw.disputed_transactions[0]?.seller.name ?? "the seller",
    updated_at: row.updated_at,
    due_at: row.due_at,
    days_left: row.due_at
      ? Math.round(((Date.parse(row.due_at) - now) / 86_400_000) * 10) / 10
      : null,
    evidence_on_file: row.evidence_on_file,
    messages: row.raw.messages,
    items,
    evidences: row.raw.evidences,
  };
}

export interface AnalysisDeps {
  store: PgStore;
  llm: Llm;
  decideUrl: string;
  /** replaces the plain LLM draft, e.g. with a cached one */
  draft?: (
    view: CaseView,
    decision: Decision | null,
    precedents: Precedent[],
    o: DecideOptions,
  ) => Promise<Draft>;
}

export interface Analysis {
  case: CaseView;
  precedents: Precedent[];
  decision: Decision | null;
  degraded?: true;
  draft: Draft;
}

export async function findPrecedents(
  store: PgStore,
  row: CaseRow,
): Promise<Precedent[]> {
  const rows = await store.precedents(
    row.reason,
    row.dispute_id,
    topTermsQuery(row.raw.search_text),
    8,
  );
  return rows.map(toPrecedent);
}

export async function decideFor(
  deps: Pick<AnalysisDeps, "decideUrl">,
  row: CaseRow,
  precedents: Precedent[],
  o: DecideOptions,
): Promise<Decision | null> {
  try {
    return await callDecide(
      deps.decideUrl,
      buildDecideRequest(row, precedents, o),
    );
  } catch {
    return null;
  }
}

export async function analyse(
  deps: AnalysisDeps,
  row: CaseRow,
  o: DecideOptions,
): Promise<Analysis> {
  const precedents = await findPrecedents(deps.store, row);
  const decision = await decideFor(deps, row, precedents, o);
  const view = toView(row);
  const draft = deps.draft
    ? await deps.draft(view, decision, precedents, o)
    : await draftResponse(
        deps.llm,
        view,
        decision,
        precedents,
        o.handlingCostCents,
      );
  return {
    case: view,
    precedents,
    decision,
    ...(decision ? {} : { degraded: true as const }),
    draft,
  };
}
