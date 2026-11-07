import type { CaseRow, DecideRequest, Decision, Precedent } from "./types.js";

export interface DecideOptions {
  prior?: number | null;
  handlingCostCents?: number;
  feeIfLostCents?: number;
}

export const DEFAULT_HANDLING_CENTS = 1500;

/** Builds the decide.v1 request. Field names are the contract (contracts/decide.v1.md). */
export function buildDecideRequest(
  row: CaseRow,
  precedents: Pick<Precedent, "dispute_id" | "won">[],
  o: DecideOptions = {},
): DecideRequest {
  return {
    contract: "decide.v1",
    amount_cents: row.amount_cents,
    currency: row.currency,
    reason: row.reason,
    stage: row.stage,
    evidence_on_file: row.evidence_on_file,
    prior: o.prior ?? null,
    handling_cost_cents: o.handlingCostCents ?? DEFAULT_HANDLING_CENTS,
    fee_if_lost_cents: o.feeIfLostCents ?? 0,
    precedents: precedents.map((p) => ({
      dispute_id: p.dispute_id,
      won: p.won,
    })),
  };
}

const NUMS = [
  "p0",
  "k",
  "wins",
  "n",
  "p",
  "ev_accept_cents",
  "ev_fight_cents",
  "margin_cents",
] as const;

/** Validates a decide.v1 response; throws when it does not match the contract. */
export function parseDecision(body: unknown): Decision {
  const b = body as Record<string, unknown> | null;
  if (!b || b["contract"] !== "decide.v1") throw new Error("bad contract");
  for (const k of NUMS)
    if (typeof b[k] !== "number") throw new Error(`decide.v1: ${k} missing`);
  if (b["call"] !== "fight" && b["call"] !== "accept")
    throw new Error("decide.v1: call missing");
  if (!Array.isArray(b["terms"])) throw new Error("decide.v1: terms missing");
  return b as unknown as Decision;
}

export async function callDecide(
  baseUrl: string,
  req: DecideRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Decision> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`decide ${res.status}`);
  return parseDecision(await res.json());
}
