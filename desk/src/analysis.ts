import type { Llm } from "@jeirslab/llm-client";
import {
  buildDecideRequest,
  callDecide,
  type DecideOptions,
} from "./decide-client.js";
import type { PgStore } from "./db.js";
import { draftResponse } from "./draft.js";
import type {
  Added,
  CaseRow,
  CaseView,
  Decision,
  Draft,
  Precedent,
} from "./types.js";

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
const flat = (x: string) =>
  x
    .replace(/<\/?mark>/g, "")
    .replace(/\s+/g, " ")
    .trim();
const firstSentence = (x: string) => /^.*?[.!?](?=\s|$)/.exec(x)?.[0];

/**
 * Plain one-line snippet: no highlight markers, no leading reason word, starting at a sentence
 * start and ending at a sentence end. `full` is the case text the snippet was cut from; with it
 * a fragment that begins mid-sentence is dropped up to the first ". ", and when nothing whole
 * remains the first whole sentence of the case text is used.
 */
export function cleanSnippet(
  snippet: string,
  reason: string,
  full?: string,
): string {
  const raw = flat(snippet);
  let s = raw;
  const lead = reason.toLowerCase().split("_")[0] ?? "";
  const first = s.split(" ")[0] ?? "";
  if (lead && first.toLowerCase() === lead) s = s.slice(first.length).trim();
  if (full) {
    const text = flat(full);
    const at = text.indexOf(raw.slice(0, 40));
    const wholeStart =
      s !== raw || (at >= 0 && (at === 0 || /[.!?] $/.test(text.slice(0, at))));
    if (!wholeStart) {
      const i = s.indexOf(". ");
      s = i >= 0 ? s.slice(i + 2).trim() : "";
    }
    if (!s || /^[a-z]/.test(s)) {
      const body =
        text.startsWith(first) && lead ? text.slice(first.length).trim() : text;
      s = firstSentence(body) ?? body.slice(0, 200);
    }
  }
  const endsOf = (x: string, max: number) => [
    ...x.slice(0, max).matchAll(/[.!?](?=\s|$)/g),
  ];
  const whole = (x: string, e: RegExpMatchArray) => x.slice(0, e.index! + 1);
  const within = endsOf(s, 200).pop();
  if (within) return whole(s, within);
  if (s.length <= 300) {
    const next = endsOf(s, 300)[0];
    if (next) return whole(s, next);
  }
  // no end in the fragment: extend to the next sentence end in the case text
  const text = full ? flat(full) : "";
  const at = text.indexOf(s);
  if (at >= 0) {
    const rest = text.slice(at);
    const next = endsOf(rest, 300)[0];
    if (next) return whole(rest, next);
  }
  if (s.length <= 200) return `${s.replace(/[\s,;:.]+$/, "")}.`;
  const cut = s.slice(0, 200);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,;:.]+$/, "")}.`;
}

export const toPrecedent = (
  r: {
    dispute_id: string;
    outcome: string;
    amount_cents: number;
    snippet: string;
    text?: string;
  },
  reason = "",
): Precedent => ({
  dispute_id: r.dispute_id,
  outcome: r.outcome,
  amount_cents: r.amount_cents,
  snippet: cleanSnippet(r.snippet, reason, r.text),
  won: r.outcome === SELLER_FAVOUR,
});

const itemsText = (
  items: { item_description: string; item_quantity: string }[],
) => items.map((i) => `${i.item_quantity} × ${i.item_description}`).join(", ");

/** Other orders of the same buyer, before or after this one: distinct transactions, oldest first. */
export function buyerHistory(row: CaseRow, others: CaseRow[]) {
  const tx = row.raw.disputed_transactions[0];
  const seen = new Set([tx?.seller_transaction_id]);
  return others
    .flatMap((o) => {
      // shortcut: every order here comes from a dispute row; one still open is itself in dispute, so it is no proof
      if (o.status !== "RESOLVED") return [];
      const t = o.raw.disputed_transactions[0];
      if (!t || !tx || seen.has(t.seller_transaction_id)) return [];
      seen.add(t.seller_transaction_id);
      return [
        {
          dispute_id: o.dispute_id,
          date: t.create_time,
          amount_cents: o.amount_cents,
          items: itemsText(t.items ?? []),
        },
      ];
    })
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

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
    ...(row.raw.disputed_transactions[0]?.create_time
      ? { purchased_at: row.raw.disputed_transactions[0].create_time }
      : {}),
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
    added?: Added[],
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
  return rows.map((r) => toPrecedent(r, row.reason));
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

/** The case view plus the buyer's earlier orders the desk knows of. */
export async function viewOf(store: PgStore, row: CaseRow): Promise<CaseView> {
  const view = toView(row);
  const history = buyerHistory(
    row,
    await store.byBuyer(row.buyer, row.dispute_id),
  );
  return history.length ? { ...view, buyer_history: history } : view;
}

export async function analyse(
  deps: AnalysisDeps,
  row: CaseRow,
  o: DecideOptions,
  added: Added[] = [],
): Promise<Analysis> {
  const precedents = await findPrecedents(deps.store, row);
  const decision = await decideFor(deps, row, precedents, o);
  const view = await viewOf(deps.store, row);
  const draft = deps.draft
    ? await deps.draft(view, decision, precedents, o, added)
    : await draftResponse(
        deps.llm,
        view,
        decision,
        precedents,
        o.handlingCostCents,
        added,
      );
  return {
    case: view,
    precedents,
    decision,
    ...(decision ? {} : { degraded: true as const }),
    draft,
  };
}
