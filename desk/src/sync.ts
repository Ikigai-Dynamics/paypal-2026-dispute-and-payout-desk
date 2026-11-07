import type { PayPalClient } from "@jeirslab/paypal-client";
import type { Dispute } from "@jeirslab/paypal-client/types";
import type { CaseRow } from "./types.js";

const words = (s: string) => s.toLowerCase().replaceAll("_", " ");

export function toCents(value: string): number {
  const neg = value.startsWith("-");
  const [w = "0", f = ""] = value.replace("-", "").split(".");
  const c = Number(w) * 100 + Number(f.padEnd(2, "0").slice(0, 2));
  return neg ? -c : c;
}

/**
 * The text Postgres full-text search indexes for a case: the reason in words, the
 * message contents, item descriptions, and evidence notes, types and carriers.
 */
export function buildSearchText(d: Dispute): string {
  const parts: string[] = [words(d.reason)];
  for (const m of d.messages) parts.push(m.content);
  for (const t of d.disputed_transactions)
    for (const i of t.items ?? []) parts.push(i.item_description);
  for (const e of d.evidences) {
    parts.push(words(e.evidence_type));
    if (e.notes) parts.push(e.notes);
    for (const t of e.evidence_info?.tracking_info ?? [])
      parts.push(`tracking ${t.carrier_name}`);
  }
  return parts.join(" ");
}

export function toRow(d: Dispute): CaseRow {
  const tx = d.disputed_transactions[0];
  return {
    dispute_id: d.dispute_id,
    reason: d.reason,
    stage: d.dispute_life_cycle_stage,
    status: d.status,
    outcome: d.outcome ?? d.dispute_outcome?.outcome_code ?? null,
    amount_cents: toCents(d.dispute_amount.value),
    currency: d.dispute_amount.currency_code,
    buyer: tx?.buyer.name ?? "unknown",
    due_at: d.seller_response_due_date ?? null,
    created_at: d.create_time,
    updated_at: d.update_time,
    evidence_on_file: d.evidences.length > 0,
    raw: { ...d, search_text: buildSearchText(d) },
  };
}

export interface Sink {
  upsert(row: CaseRow): Promise<void>;
}

/** Lists every page of disputes, fetches each in full, and upserts. Returns the count. */
export async function syncAll(
  paypal: PayPalClient,
  sink: Sink,
  pageSize = 50,
): Promise<number> {
  let count = 0;
  let token: string | undefined;
  for (;;) {
    const page = await paypal.disputes.list({
      page_size: pageSize,
      ...(token ? { next_page_token: token } : {}),
    });
    for (const s of page.items) {
      const full = await paypal.disputes.get(s.dispute_id);
      await sink.upsert(toRow(full));
      count++;
    }
    const next = page.links.find((l) => l.rel === "next");
    if (!next || page.items.length === 0) break;
    token = new URL(next.href).searchParams.get("next_page_token") ?? undefined;
    if (!token) break;
  }
  return count;
}

/** Re-reads one case from PayPal and upserts it. */
export async function refreshCase(
  paypal: PayPalClient,
  sink: Sink,
  id: string,
): Promise<CaseRow> {
  const row = toRow(await paypal.disputes.get(id));
  await sink.upsert(row);
  return row;
}

/** Writes a seller response as evidence, then re-reads the case from PayPal and upserts it. */
export async function submitEvidence(
  paypal: PayPalClient,
  sink: Sink,
  id: string,
  text: string,
): Promise<CaseRow> {
  await paypal.disputes.provideEvidence(id, {
    evidences: [{ evidence_type: "OTHER", notes: text }],
  });
  return refreshCase(paypal, sink, id);
}

/** Accepts the claim (refund in full), then re-reads the case and upserts it. */
export async function acceptClaim(
  paypal: PayPalClient,
  sink: Sink,
  id: string,
  note: string,
): Promise<CaseRow> {
  await paypal.disputes.acceptClaim(id, { note });
  return refreshCase(paypal, sink, id);
}
