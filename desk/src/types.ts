import type { Dispute, Evidence } from "@jeirslab/paypal-client/types";

/** One row of the cases table. PayPal is the source of truth; this is an index. */
export interface CaseRow {
  dispute_id: string;
  reason: string;
  stage: string;
  status: string;
  outcome: string | null;
  amount_cents: number;
  currency: string;
  buyer: string;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_on_file: boolean;
  raw: Dispute & { search_text: string };
}

/** What the API and the page see for a case. */
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
  messages: Dispute["messages"];
  items: { item_description: string; item_quantity: string }[];
  evidences: Evidence[];
  /** create_time of the disputed transaction */
  purchased_at?: string;
  /** the buyer's other orders the desk knows of, oldest first */
  buyer_history?: BuyerOrder[];
  /** disputes of this buyer waiting for a response, this case included */
  buyer_open_disputes?: number;
  /** Parley's call on the list rows: "fight", "accept" or "offer", null while undecided */
  call?: string | null;
  offer_cents?: number | null;
  p?: number | null;
  p_lo?: number | null;
  p_hi?: number | null;
  keep_cents?: number | null;
}

export interface BuyerOrder {
  dispute_id: string;
  date: string;
  amount_cents: number;
  items: string;
}

export interface Precedent {
  dispute_id: string;
  outcome: string;
  won: boolean;
  amount_cents: number;
  snippet: string;
}

export interface Assumption {
  id: string;
  /** plain-language name for screens */
  label: string;
  value: number;
  unit: string;
  source: string;
}

export interface Offer {
  amount_cents: number;
  /** estimated chance the buyer takes it */
  q: number;
  ev_cents: number;
}

export interface Decision {
  contract: "decide.v2";
  core_version: string;
  assumptions_version: string;
  p0: number;
  p0_source: string;
  k: number;
  wins: number;
  n: number;
  /** estimated chance of winning, with an 80% range */
  p: number;
  p_lo: number;
  p_hi: number;
  ai_cost_cents: number;
  fight_cost_cents: number;
  ev_accept_cents: number;
  ev_fight_cents: number;
  ev_offer_cents: number | null;
  /** the best partial refund found; it is the call only when call is "offer" */
  offer: Offer | null;
  margin_cents: number;
  marginal: boolean;
  call: "fight" | "accept" | "offer";
  /** the money the seller likely keeps: amount plus the EV of the call */
  keep_cents: number;
  /** the buyer disputes so often that no partial refund is offered */
  buyer_flag?: boolean;
  buyer_orders?: number;
  buyer_disputes?: number;
  assumptions: Assumption[];
  terms: string[];
}

export interface DecideRequest {
  contract: "decide.v2";
  amount_cents: number;
  currency: string;
  reason: string;
  stage: string;
  evidence_on_file: boolean;
  prior: number | null;
  handling_cost_cents: number;
  ai_cost_cents: number;
  fee_if_lost_cents: number;
  precedents: { dispute_id: string; won: boolean }[];
  /** orders and disputes with this seller, counted as the Buyer tab counts them */
  buyer_orders: number;
  buyer_disputes: number;
}

export interface ChecklistItem {
  item: string;
  /** exactly one item per reason must be supplied before the response can go */
  required: boolean;
  status: "present" | "missing";
  why: string;
  /** set only on missing items the desk holds real data for */
  suggestion?: { label: string; note: string };
}

/** Evidence the merchant typed in before asking for a new draft. */
export interface Added {
  item: string;
  note: string;
}

export interface Draft {
  response: string;
  checklist: ChecklistItem[];
  explanation: string;
  source: "llm" | "fallback";
  /** "AI draft", "AI draft, updated with your evidence", "Drafted from the case facts" / "Drafted from your evidence" or "Template draft (AI unavailable)", shown verbatim next to the text */
  label: string;
  model?: string;
  /** USD this draft cost to write (all model calls, retries included); 0 for a fallback */
  cost_usd?: number;
  error?: string;
  /** set on a fallback: the model call failed, or nothing it wrote was grounded */
  fallback_reason?: "ai_down" | "grounding";
}

/** Validated structured evidence and files sent with a response. */
export interface Extra {
  evidence: {
    item: string;
    evidence_type: string;
    notes: string;
    tracking?: { carrier: string; number: string };
  }[];
  files: { name: string; content_type: string; data_base64: string }[];
}
