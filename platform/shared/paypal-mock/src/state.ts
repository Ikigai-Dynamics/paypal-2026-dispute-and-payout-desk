import { randomBytes } from "node:crypto";
import type {
  Authorization,
  CreatePayoutRequest,
  Dispute,
  DisputeReason,
  DisputeStage,
  DisputeStatus,
  Order,
  PayoutItem,
  PayoutItemStatus,
  SenderBatchHeader,
  TransactionDetail,
} from "@jeirslab/paypal-client/types";
import { fromCents, money, payoutFeeCents, toCents } from "./money.js";
import { Prng } from "./prng.js";
import { loadDataset, type DemoDataset } from "./dataset.js";
import { seedDisputes, seedTransactions } from "./seed.js";

export interface MockConfig {
  port: number;
  host: string;
  seed: number;
  /** path of a demo dataset (JSON); when set it replaces the generator */
  seedFile?: string;
  /** anchor (ms since epoch) for seeded dates */
  now: number;
  /** true when now is the wall clock (MOCK_NOW=now, or a dataset without MOCK_NOW): every reseed re-anchors it */
  liveNow?: boolean;
  seedTransactions: number;
  seedDisputes: number;
  seedDays: number;
  autoApprove: boolean;
  payoutSeconds: number;
  latencyMs: number;
  failureEvery: number;
  strictAuth: boolean;
  log: boolean;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined || v === ""
    ? d
    : !["false", "0", "no", "off"].includes(v.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MockConfig {
  // MOCK_NOW=now anchors seeded dates at process start so deadlines stay in the future
  const nowRaw = env["MOCK_NOW"];
  const seedFile = env["MOCK_SEED_FILE"] || undefined;
  const liveNow = nowRaw === "now" || (!!seedFile && !nowRaw);
  const now = liveNow
    ? Date.now()
    : Date.parse(nowRaw || "2026-11-06T00:00:00Z");
  return {
    port: num(env["PORT"], 8080),
    host: env["HOST"] || "0.0.0.0",
    seed: num(env["MOCK_SEED"], 42),
    ...(seedFile ? { seedFile } : {}),
    liveNow,
    now: Number.isNaN(now) ? Date.parse("2026-11-06T00:00:00Z") : now,
    seedTransactions: num(env["MOCK_SEED_TRANSACTIONS"], 500),
    seedDisputes: num(env["MOCK_SEED_DISPUTES"], 40),
    seedDays: num(env["MOCK_SEED_DAYS"], 90),
    autoApprove: bool(env["MOCK_AUTO_APPROVE"], true),
    payoutSeconds: num(env["MOCK_PAYOUT_SECONDS"], 5),
    latencyMs: num(env["MOCK_LATENCY_MS"], 0),
    failureEvery: num(env["MOCK_FAILURE_EVERY"], 0),
    strictAuth: bool(env["MOCK_STRICT_AUTH"], true),
    log: true,
  };
}

export interface PayoutBatchRec {
  id: string;
  header: SenderBatchHeader;
  createdMs: number;
  items: PayoutItem[];
  settled: boolean;
}

export interface AuthorizationRec {
  auth: Authorization;
  orderId: string;
  capturedCents: number;
  currency: string;
  description: string;
}

export interface StoredReply {
  status: number;
  body: unknown;
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function liveId(len: number): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHA[b[i]! % ALPHA.length];
  return s;
}

export class MockState {
  orders = new Map<string, Order>();
  approved = new Set<string>();
  authorizations = new Map<string, AuthorizationRec>();
  payouts = new Map<string, PayoutBatchRec>();
  batchIds = new Set<string>();
  disputes = new Map<string, Dispute>();
  transactions: TransactionDetail[] = [];
  idempotency = new Map<string, StoredReply>();
  requestCount = 0;

  constructor(public config: MockConfig) {
    this.reseed();
  }

  dataset: Omit<DemoDataset, "transactions" | "disputes"> | null = null;

  /** Clears everything and re-seeds: from the dataset file, or (an explicit seed, or no file) the generator. Deterministic. */
  reseed(seed?: number): void {
    if (seed !== undefined) this.config.seed = seed;
    // a long-running mock would otherwise serve deadlines that passed days ago
    if (this.config.liveNow) this.config.now = Date.now();
    this.orders.clear();
    this.approved.clear();
    this.authorizations.clear();
    this.payouts.clear();
    this.batchIds.clear();
    this.disputes.clear();
    this.idempotency.clear();
    this.requestCount = 0;
    if (seed === undefined && this.config.seedFile) {
      const { transactions, disputes, ...rest } = loadDataset(
        this.config.seedFile,
        this.config.now,
      );
      this.dataset = rest;
      this.transactions = transactions;
      for (const d of disputes) this.disputes.set(d.dispute_id, d);
      return;
    }
    this.dataset = null;
    const rng = new Prng(this.config.seed);
    this.transactions = seedTransactions(rng, this.config);
    for (const d of seedDisputes(rng, this.config, this.transactions))
      this.disputes.set(d.dispute_id, d);
  }

  /** Seeded data only; used by the determinism test. */
  serialize(): string {
    return JSON.stringify({
      transactions: this.transactions,
      disputes: [...this.disputes.values()],
    });
  }

  counts() {
    return {
      seed: this.config.seed,
      ...(this.dataset ? { dataset: this.dataset.merchant["name"] } : {}),
      orders: this.orders.size,
      payouts: this.payouts.size,
      disputes: this.disputes.size,
      transactions: this.transactions.length,
    };
  }

  addTransaction(t: TransactionDetail): void {
    this.transactions.push(t);
    this.transactions.sort(
      (a, b) =>
        Date.parse(a.transaction_info.transaction_initiation_date) -
          Date.parse(b.transaction_info.transaction_initiation_date) ||
        a.transaction_info.transaction_id.localeCompare(
          b.transaction_info.transaction_id,
        ),
    );
  }

  newTransaction(
    code: string,
    cents: number,
    currency: string,
    subject: string,
    whenMs: number,
    feeCents = 0,
  ): TransactionDetail {
    const iso = new Date(whenMs).toISOString();
    return {
      transaction_info: {
        paypal_account_id: "MOCKMERCHANT01",
        transaction_id: liveId(17),
        transaction_event_code: code,
        transaction_initiation_date: iso,
        transaction_updated_date: iso,
        transaction_amount: money(cents, currency),
        fee_amount: money(-feeCents, currency),
        transaction_status: "S",
        transaction_subject: subject,
      },
      payer_info: {
        account_id: "MOCKBUYER0001",
        email_address: "buyer@example.com",
        payer_name: { given_name: "Mock", surname: "Buyer" },
        country_code: "US",
        account_status: "VERIFIED",
      },
      shipping_info: {
        name: "Mock Buyer",
        address: { city: "Austin", state: "TX", country_code: "US" },
      },
      cart_info: { item_details: [] },
    };
  }

  createPayout(req: CreatePayoutRequest): PayoutBatchRec {
    const id = liveId(13);
    const items: PayoutItem[] = req.items.map((it, i) => {
      const receiver = it.receiver.toLowerCase();
      const status: PayoutItemStatus = receiver.endsWith("@fail.example")
        ? "FAILED"
        : receiver.endsWith("@unclaimed.example")
          ? "UNCLAIMED"
          : "SUCCESS";
      const feeCents = payoutFeeCents(toCents(it.amount.value));
      const itemId = liveId(13);
      return {
        payout_item_id: itemId,
        ...(status === "SUCCESS" ? { transaction_id: liveId(17) } : {}),
        transaction_status: status,
        payout_item_fee: {
          currency: it.amount.currency,
          value: fromCents(feeCents),
        },
        payout_batch_id: id,
        payout_item: {
          ...it,
          sender_item_id: it.sender_item_id ?? `item-${i + 1}`,
        },
        ...(status === "FAILED"
          ? {
              errors: {
                name: "RECEIVER_UNREGISTERED",
                message: "Receiver is unregistered",
              },
            }
          : {}), // unverified
        links: [],
      };
    });
    const rec: PayoutBatchRec = {
      id,
      header: req.sender_batch_header,
      createdMs: Date.now(),
      items,
      settled: false,
    };
    this.payouts.set(id, rec);
    this.batchIds.add(req.sender_batch_header.sender_batch_id);
    return rec;
  }

  payoutStatus(rec: PayoutBatchRec): "PENDING" | "PROCESSING" | "SUCCESS" {
    const elapsed = (Date.now() - rec.createdMs) / 1000;
    const s = this.config.payoutSeconds;
    if (elapsed >= s) return "SUCCESS";
    if (elapsed >= s / 2) return "PROCESSING";
    return "PENDING";
  }

  /** Writes Transaction Search entries for payouts that completed since the last call. */
  settlePayouts(): void {
    for (const rec of this.payouts.values()) {
      if (rec.settled || this.payoutStatus(rec) !== "SUCCESS") continue;
      rec.settled = true;
      const when = rec.createdMs + this.config.payoutSeconds * 1000;
      for (const it of rec.items) {
        if (it.transaction_status !== "SUCCESS") continue;
        it.time_processed = new Date(when).toISOString();
        const t = this.newTransaction(
          "T0000", // unverified mapping for payouts
          -toCents(it.payout_item.amount.value),
          it.payout_item.amount.currency,
          `Payout to ${it.payout_item.receiver}`,
          when,
          toCents(it.payout_item_fee.value),
        );
        t.transaction_info.transaction_id =
          it.transaction_id ?? t.transaction_info.transaction_id;
        this.addTransaction(t);
      }
    }
  }
}

export const DISPUTE_STATE: Record<DisputeStatus, string> = {
  OPEN: "OPEN_INQUIRIES",
  WAITING_FOR_BUYER_RESPONSE: "REQUIRED_OTHER_PARTY_ACTION",
  WAITING_FOR_SELLER_RESPONSE: "REQUIRED_ACTION",
  UNDER_REVIEW: "UNDER_PAYPAL_REVIEW",
  RESOLVED: "RESOLVED",
  OTHER: "OTHER",
};

export const DISPUTE_REASONS: readonly DisputeReason[] = [
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
];
export const DISPUTE_STAGES: readonly DisputeStage[] = [
  "INQUIRY",
  "CHARGEBACK",
  "PRE_ARBITRATION",
  "ARBITRATION",
];
