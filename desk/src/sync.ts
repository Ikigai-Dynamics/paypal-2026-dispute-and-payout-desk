import type { PayPalClient } from "@jeirslab/paypal-client";
import type { Dispute, Evidence } from "@jeirslab/paypal-client/types";
import type { CaseRow, Extra } from "./types.js";

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
  extra?: Extra,
): Promise<CaseRow> {
  const evidences: Evidence[] = [{ evidence_type: "OTHER", notes: text }];
  for (const e of extra?.evidence ?? [])
    evidences.push({
      evidence_type: e.evidence_type,
      notes: e.notes,
      ...(e.tracking
        ? {
            evidence_info: {
              tracking_info: [
                {
                  carrier_name: e.tracking.carrier,
                  tracking_number: e.tracking.number,
                },
              ],
            },
          }
        : {}),
    });
  const files = (extra?.files ?? []).map((f) => ({
    name: f.name,
    contentType: f.content_type,
    data: Buffer.from(f.data_base64, "base64"),
  }));
  await paypal.disputes.provideEvidence(id, {
    evidences,
    ...(files.length ? { files } : {}),
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

const TYPES = ["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "OTHER"];
const FILE_TYPES = ["image/png", "image/jpeg", "application/pdf"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const bad = (m: string) => new ValidationError(m);

export class ValidationError extends Error {}

const str = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw bad("each entry must be an object");
  return v as Record<string, unknown>;
};

/** Validates the optional structured evidence and files of a submit. Throws ValidationError. */
export function parseExtra(b: Record<string, unknown>): Extra | undefined {
  const out: Extra = { evidence: [], files: [] };
  if (b["evidence"] !== undefined) {
    if (!Array.isArray(b["evidence"]) || b["evidence"].length > 5)
      throw bad("evidence must be a list of at most 5 items");
    for (const raw of b["evidence"]) {
      const e = obj(raw);
      if (!str(e["item"], 1, 80))
        throw bad("evidence item must be 1 to 80 characters");
      if (typeof e["evidence_type"] !== "string" || !TYPES.includes(e["evidence_type"]))
        throw bad(`evidence_type must be one of ${TYPES.join(", ")}`);
      if (!str(e["notes"], 1, 2000))
        throw bad("evidence notes must be 1 to 2000 characters");
      let tracking: Extra["evidence"][number]["tracking"];
      if (e["tracking"] !== undefined) {
        const t = obj(e["tracking"]);
        if (!str(t["carrier"], 1, 40))
          throw bad("tracking carrier must be 1 to 40 characters");
        if (!str(t["number"], 1, 40) || !/^[A-Za-z0-9 -]+$/.test(t["number"]))
          throw bad(
            "tracking number must be 1 to 40 letters, digits, spaces or dashes",
          );
        tracking = { carrier: t["carrier"], number: t["number"] };
      }
      out.evidence.push({
        item: e["item"],
        evidence_type: e["evidence_type"],
        notes: e["notes"],
        ...(tracking ? { tracking } : {}),
      });
    }
  }
  if (b["files"] !== undefined) {
    if (!Array.isArray(b["files"]) || b["files"].length > 3)
      throw bad("files must be a list of at most 3 items");
    for (const raw of b["files"]) {
      const f = obj(raw);
      if (!str(f["name"], 1, 100) || /[/\\]/.test(f["name"]))
        throw bad("file name must be 1 to 100 characters without slashes");
      if (typeof f["content_type"] !== "string" || !FILE_TYPES.includes(f["content_type"]))
        throw bad(`file type must be one of ${FILE_TYPES.join(", ")}`);
      const data = f["data_base64"];
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
        throw bad("file data must be base64");
      const n = Buffer.from(data, "base64").length;
      if (n < 1 || n > MAX_FILE_BYTES)
        throw bad("each file must be between 1 byte and 5 MB");
      out.files.push({
        name: f["name"],
        content_type: f["content_type"],
        data_base64: data,
      });
    }
  }
  return out.evidence.length || out.files.length ? out : undefined;
}
