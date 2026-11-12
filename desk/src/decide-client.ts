import type {
  Assumption,
  CaseRow,
  DecideRequest,
  Decision,
  Precedent,
} from "./types.js";

export interface DecideOptions {
  prior?: number | null;
  handlingCostCents?: number;
  feeIfLostCents?: number;
  /** what the AI work on this case cost so far, in cents */
  aiCostCents?: number;
  /** the buyer's orders with this seller; null/absent when really unknown */
  buyerOrders?: number | null;
  /** the buyer's disputes in the index, this case included */
  buyerDisputes?: number;
}

export const DEFAULT_HANDLING_CENTS = 1500;

/** A whole, non-negative number of cents; anything else is 0. */
export const safeCents = (c: number | undefined): number =>
  Number.isFinite(c) && c! > 0 ? Math.round(c!) : 0;

const safeCount = (n: number | undefined): number =>
  Number.isFinite(n) && n! > 0 ? Math.floor(n!) : 0;

/** Builds the decide.v2 request. Field names are the contract (contracts/decide.v2.md). */
export function buildDecideRequest(
  row: CaseRow,
  precedents: Pick<Precedent, "dispute_id" | "won">[],
  o: DecideOptions = {},
): DecideRequest {
  return {
    contract: "decide.v2",
    amount_cents: row.amount_cents,
    currency: row.currency,
    reason: row.reason,
    stage: row.stage,
    evidence_on_file: row.evidence_on_file,
    prior: o.prior ?? null,
    handling_cost_cents: o.handlingCostCents ?? DEFAULT_HANDLING_CENTS,
    ai_cost_cents: safeCents(o.aiCostCents),
    fee_if_lost_cents: o.feeIfLostCents ?? 0,
    // decide.v2 defaults a missing buyer_orders to 0 and lifts it to the dispute count, so unknown orders are left out
    // rather than copied from disputes; orders below disputes are treated as unknown too
    ...(o.buyerOrders != null &&
    safeCount(o.buyerOrders) >= safeCount(o.buyerDisputes)
      ? { buyer_orders: safeCount(o.buyerOrders) }
      : {}),
    buyer_disputes: safeCount(o.buyerDisputes),
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
  "p_lo",
  "p_hi",
  "ai_cost_cents",
  "fight_cost_cents",
  "keep_cents",
  "ev_accept_cents",
  "ev_fight_cents",
  "margin_cents",
] as const;

/** Validates a decide.v2 response; throws when it does not match the contract. */
export function parseDecision(body: unknown): Decision {
  const b = body as Record<string, unknown> | null;
  if (!b || b["contract"] !== "decide.v2") throw new Error("bad contract");
  for (const k of NUMS)
    if (typeof b[k] !== "number") throw new Error(`decide.v2: ${k} missing`);
  if (b["call"] !== "fight" && b["call"] !== "accept" && b["call"] !== "offer")
    throw new Error("decide.v2: call missing");
  if (!Array.isArray(b["terms"])) throw new Error("decide.v2: terms missing");
  if (!Array.isArray(b["assumptions"]))
    throw new Error("decide.v2: assumptions missing");
  if (b["buyer_flag"] !== undefined && typeof b["buyer_flag"] !== "boolean")
    throw new Error("decide.v2: buyer_flag invalid");
  if (b["offer"] !== null && typeof b["offer"] !== "object")
    throw new Error("decide.v2: offer missing");
  return b as unknown as Decision;
}

export async function callDecide(
  baseUrl: string,
  req: DecideRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Decision> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v2/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`decide ${res.status}`);
  return parseDecision(await res.json());
}

export async function callAssumptions(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ version: string; assumptions: Assumption[] }> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v2/assumptions`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`decide ${res.status}`);
  const b = (await res.json()) as { version?: unknown; assumptions?: unknown };
  if (typeof b.version !== "string" || !Array.isArray(b.assumptions))
    throw new Error("decide.v2: assumptions missing");
  return b as { version: string; assumptions: Assumption[] };
}
