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
  call: "fight" | "accept";
  terms: string[];
}

export interface DecideRequest {
  contract: "decide.v1";
  amount_cents: number;
  currency: string;
  reason: string;
  stage: string;
  evidence_on_file: boolean;
  prior: number | null;
  handling_cost_cents: number;
  fee_if_lost_cents: number;
  precedents: { dispute_id: string; won: boolean }[];
}

export interface ChecklistItem {
  item: string;
  status: "present" | "missing";
  why: string;
}

export interface Draft {
  response: string;
  checklist: ChecklistItem[];
  explanation: string;
  source: "llm" | "fallback";
  /** "AI (model)" or "offline fallback", to show next to the text */
  label: string;
  model?: string;
  error?: string;
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
