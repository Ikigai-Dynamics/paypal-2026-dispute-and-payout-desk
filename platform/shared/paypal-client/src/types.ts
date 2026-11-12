// Hand-written subset of the PayPal REST shapes used by the hackathon projects.
// Shared by @jeirslab/paypal-client and @jeirslab/paypal-mock. Fields follow the
// public OpenAPI specs; anything not confirmed there is marked "unverified".

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface LinksResponse {
  links: Link[];
}

export interface PayPalErrorDetail {
  field?: string;
  value?: string;
  location?: string;
  issue: string;
  description?: string;
}

export interface PayPalErrorBody {
  name: string;
  message: string;
  debug_id: string;
  details: PayPalErrorDetail[];
  links: Link[];
}

// ---- Orders v2 ----
export interface PurchaseUnitRequest {
  reference_id?: string;
  amount: Money;
  description?: string;
  custom_id?: string;
  invoice_id?: string;
}

export interface CreateOrderRequest {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: PurchaseUnitRequest[];
  payment_source?: { paypal?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

export interface Capture {
  id: string;
  status: string;
  amount: Money;
  final_capture: boolean;
  seller_protection: { status: string; dispute_categories: string[] };
  seller_receivable_breakdown: {
    gross_amount: Money;
    paypal_fee: Money;
    net_amount: Money;
  };
  create_time: string;
  update_time: string;
  links: Link[];
}

// ---- Payments v2 authorizations ----
export interface Authorization {
  id: string;
  status: "CREATED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED";
  amount: Money;
  expiration_time: string;
  create_time: string;
  update_time: string;
  links: Link[];
}

export interface PurchaseUnit extends PurchaseUnitRequest {
  reference_id: string;
  payments?: { captures: Capture[]; authorizations?: Authorization[] };
}

export interface Payer {
  email_address: string;
  account_id: string;
  name: { given_name: string; surname: string };
}

export interface Order {
  id: string;
  intent: "CAPTURE" | "AUTHORIZE";
  status:
    | "CREATED"
    | "SAVED"
    | "APPROVED"
    | "VOIDED"
    | "COMPLETED"
    | "PAYER_ACTION_REQUIRED";
  purchase_units: PurchaseUnit[];
  payer?: Payer;
  payment_source?: {
    paypal?: Partial<Payer> & Record<string, unknown>;
  } & Record<string, unknown>;
  create_time?: string;
  update_time?: string;
  links: Link[];
}

// ---- Payouts v1 ----
export type RecipientType = "EMAIL" | "PHONE" | "PAYPAL_ID";

export interface SenderBatchHeader {
  sender_batch_id: string;
  email_subject?: string;
  email_message?: string;
  recipient_type?: RecipientType;
}

export interface PayoutItemRequest {
  recipient_type: RecipientType;
  amount: { value: string; currency: string };
  receiver: string;
  note?: string;
  sender_item_id?: string;
}

export interface CreatePayoutRequest {
  sender_batch_header: SenderBatchHeader;
  items: PayoutItemRequest[];
}

export interface CreatePayoutResponse {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header: SenderBatchHeader;
  };
  links: Link[];
}

export type PayoutBatchStatus =
  "PENDING" | "PROCESSING" | "SUCCESS" | "DENIED" | "CANCELED";
export type PayoutItemStatus =
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "UNCLAIMED"
  | "RETURNED"
  | "ONHOLD"
  | "BLOCKED"
  | "REFUNDED"
  | "REVERSED";

export interface PayoutItem {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status: PayoutItemStatus;
  payout_item_fee: { currency: string; value: string };
  payout_batch_id: string;
  payout_item: PayoutItemRequest;
  time_processed?: string;
  errors?: { name: string; message: string };
  links: Link[];
}

export interface PayoutBatch {
  batch_header: {
    payout_batch_id: string;
    batch_status: PayoutBatchStatus;
    time_created: string;
    time_completed?: string;
    sender_batch_header: SenderBatchHeader;
    amount: { currency: string; value: string };
    fees: { currency: string; value: string };
  };
  items: PayoutItem[];
  total_items?: number;
  total_pages?: number;
  links: Link[];
}

// ---- Disputes v1 ----
export type DisputeStatus =
  | "OPEN"
  | "WAITING_FOR_BUYER_RESPONSE"
  | "WAITING_FOR_SELLER_RESPONSE"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "OTHER";
export type DisputeStage =
  "INQUIRY" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION";
export type DisputeChannel = "INTERNAL" | "EXTERNAL";
export type DisputeReason =
  | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
  | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
  | "UNAUTHORISED"
  | "CREDIT_NOT_PROCESSED"
  | "DUPLICATE_TRANSACTION"
  | "INCORRECT_AMOUNT"
  | "PAYMENT_BY_OTHER_MEANS"
  | "CANCELED_RECURRING_BILLING"
  | "PROBLEM_WITH_REMITTANCE"
  | "OTHER";

export interface DisputeSummary {
  dispute_id: string;
  create_time: string;
  update_time: string;
  reason: DisputeReason;
  status: DisputeStatus;
  dispute_state?: string;
  dispute_amount: Money;
  dispute_life_cycle_stage: DisputeStage;
  dispute_channel: DisputeChannel;
  outcome?: string;
  links: Link[];
}

export interface Dispute extends DisputeSummary {
  disputed_transactions: {
    seller_transaction_id: string;
    create_time: string;
    transaction_status: string;
    gross_amount: Money;
    buyer: { name: string };
    seller: { merchant_id: string; name: string };
    // unverified field shape: PayPal's real items[] carries more fields (item_id, partner_transaction_id)
    items?: { item_description: string; item_quantity: string }[];
  }[];
  seller_response_due_date?: string;
  messages: {
    posted_by: "BUYER" | "SELLER";
    time_posted: string;
    content: string;
  }[];
  evidences: Evidence[];
  dispute_outcome?: { outcome_code: string; amount_refunded?: Money };
  offer?: {
    buyer_requested_amount?: Money;
    offer_type: string;
    seller_offered_amount: Money;
    history?: {
      offer_time: string;
      actor: string;
      event_type: string;
      notes?: string;
      offer_type: string;
      offer_amount: Money;
    }[];
  };
}

export interface DisputeList {
  items: DisputeSummary[];
  links: Link[];
}

export interface ListDisputesQuery {
  dispute_state?: string;
  start_time?: string;
  update_time_after?: string;
  disputed_transaction_id?: string;
  page_size?: number;
  next_page_token?: string;
}

export interface Evidence {
  evidence_type: string;
  evidence_info?: {
    tracking_info?: { carrier_name: string; tracking_number: string }[];
    refund_ids?: string[];
  };
  notes?: string;
}

export interface AcceptClaimRequest {
  note: string;
  accept_claim_reason?: string;
  refund_amount?: Money;
}

export interface MakeOfferRequest {
  note: string;
  offer_amount: Money;
  offer_type?:
    | "REFUND"
    | "REFUND_WITH_RETURN"
    | "REFUND_WITH_REPLACEMENT"
    | "REPLACEMENT_WITHOUT_REFUND";
  invoice_id?: string;
  return_shipping_address?: {
    address_line_1: string;
    address_line_2?: string;
    admin_area_2: string;
    admin_area_1?: string;
    postal_code?: string;
    country_code: string;
  };
}

// ---- Transaction Search v1 ----
export interface TransactionSearchQuery {
  start_date: string;
  end_date: string;
  transaction_id?: string;
  transaction_status?: "D" | "P" | "S" | "V";
  transaction_amount?: string;
  page_size?: number;
  page?: number;
  fields?: string;
}

export interface TransactionDetail {
  transaction_info: {
    paypal_account_id: string;
    transaction_id: string;
    transaction_event_code: string;
    transaction_initiation_date: string;
    transaction_updated_date: string;
    transaction_amount: Money;
    fee_amount?: Money;
    transaction_status: string;
    transaction_subject?: string;
    invoice_id?: string;
    custom_field?: string;
  };
  payer_info: {
    account_id: string;
    email_address: string;
    payer_name: { given_name: string; surname: string };
    country_code: string;
    account_status?: "VERIFIED" | "UNVERIFIED";
  };
  shipping_info?: {
    name?: string;
    address: { city: string; state?: string; country_code: string };
  };
  cart_info: { item_details: unknown[] };
}

export interface TransactionSearchResponse {
  transaction_details: TransactionDetail[];
  account_number: string;
  start_date: string;
  end_date: string;
  last_refreshed_datetime: string;
  page: number;
  total_items: number;
  total_pages: number;
  links: Link[];
}
