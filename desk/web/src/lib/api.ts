export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(String(status));
    this.status = status;
    this.body = body;
  }
}

/** fetch + JSON; a non-2xx answer throws an ApiError carrying the parsed body */
export async function api<T = any>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body);
  return body as T;
}
const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data),
});
export const post = <T = any>(path: string, data: unknown) =>
  api<T>(path, json("POST", data));
export const put = <T = any>(path: string, data: unknown) =>
  api<T>(path, json("PUT", data));

export interface CaseSummary {
  dispute_id: string;
  reason: string;
  stage: string;
  status: string;
  outcome: string | null;
  amount_cents: number;
  currency: string;
  buyer: string;
  item: string | null;
  item_quantity: string | number | null;
  items: { item_description: string; item_quantity: string | number }[];
  due_at: string | null;
  days_left: number | null;
  evidence_on_file: boolean;
  call?: string | null;
  margin_cents?: number | null;
  /** Parley's call in the list (decide.v2): the offer, the win chance with its interval, what is likely kept */
  offer_cents?: number | null;
  p?: number | null;
  p_lo?: number | null;
  p_hi?: number | null;
  keep_cents?: number | null;
}

export interface Summary {
  total: number;
  needs_response: number;
  under_review: number;
  closed: number;
  missed_deadline: number;
  waiting_on_buyer: number;
  other: number;
  at_stake_cents: number;
  currency: string;
  [k: string]: number | string;
}

export interface BuyerOrder {
  dispute_id: string;
  date: string;
  amount_cents: number;
  items: string;
}

export interface Evidence {
  evidence_type?: string;
  notes?: string;
  evidence_info?: {
    tracking_info?: { carrier_name?: string; tracking_number?: string }[];
  };
}

export interface CaseView {
  dispute_id: string;
  reason: string;
  stage: string;
  status: string;
  outcome: string | null;
  amount_cents: number;
  currency: string;
  buyer: string;
  merchant: string;
  updated_at: string;
  due_at: string | null;
  days_left: number | null;
  evidence_on_file: boolean;
  messages: { posted_by?: string; time_posted?: string; content: string }[];
  items: { item_description: string; item_quantity: string }[];
  evidences: Evidence[];
  purchased_at?: string;
  buyer_history?: BuyerOrder[];
  buyer_open_disputes?: number;
}

export interface Precedent {
  dispute_id: string;
  outcome: string;
  won: boolean;
  amount_cents: number;
  snippet: string;
}

export interface Decision {
  contract: "decide.v1";
  p0: number;
  p0_source: string;
  k: number;
  wins: number;
  n: number;
  p: number;
  ev_accept_cents: number;
  ev_fight_cents: number;
  margin_cents: number;
  marginal: boolean;
  call: "fight" | "accept" | "offer";
  terms: string[];
  // decide.v2; every field may be missing on an older core
  p_lo?: number;
  p_hi?: number;
  offer?: { amount_cents: number; q: number; ev_cents: number } | null;
  keep_cents?: number;
  ai_cost_cents?: number;
  assumptions?: Assumption[];
}

export interface Assumption {
  id: string;
  value: string | number;
  unit?: string;
  source?: string;
}

/** GET /api/cases/:id/buyer: what PayPal lets a seller see about the buyer */
export interface BuyerInfo {
  name?: string;
  account_status?: string;
  payer_id?: string;
  email?: string;
  country?: string;
  ship_to?: string;
  orders?: number;
  disputes?: number;
  first_order?: string;
  address_matches?: boolean | null;
}

export interface ChecklistItem {
  item: string;
  required: boolean;
  status: "present" | "missing";
  why: string;
  suggestion?: { label: string; note: string };
}

export interface Draft {
  response: string;
  checklist: ChecklistItem[];
  explanation: string;
  source: "llm" | "fallback";
  label: string;
  model?: string;
  error?: string;
  fallback_reason?: "ai_down" | "grounding";
}

export type AddedEvidence = {
  item: string;
  evidence_type: string;
  notes: string;
  tracking?: { carrier: string; number: string };
  file?: { name: string; content_type: string; data_base64: string };
};

export type Claim = {
  sentence: string;
  reason?: string;
  kind?: string;
  ok: boolean;
};

export type Analysis = {
  case: CaseView;
  precedents: Precedent[];
  decision: Decision | null;
  draft: Draft;
  work: {
    added?: AddedEvidence[];
    draft_text?: string;
    draft_label?: string;
    edited?: boolean;
  } | null;
  sent: { text?: string; added?: AddedEvidence[]; vouched?: string[] } | null;
  /** the model is writing a fresh draft; the fallback shown is temporary */
  drafting?: boolean;
};

export interface ActivityCall {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  dispute_id?: string | null;
  buyer?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
}

export interface Info {
  bootId?: string;
  paypalEnv: string;
  llm: { online: boolean; label?: string };
  sync: { error?: string | null };
}
