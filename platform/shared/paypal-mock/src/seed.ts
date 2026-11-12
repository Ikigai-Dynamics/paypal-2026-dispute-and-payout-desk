import type {
  Dispute,
  DisputeReason,
  DisputeStatus,
  Evidence,
  TransactionDetail,
} from "@jeirslab/paypal-client/types";
import { money, paypalFeeCents } from "./money.js";
import type { Prng } from "./prng.js";
import type { MockConfig } from "./state.js";
import { DISPUTE_REASONS, DISPUTE_STATE } from "./state.js";

const GIVEN = [
  "Ava",
  "Liam",
  "Noah",
  "Mia",
  "Zoe",
  "Ethan",
  "Ivy",
  "Leo",
  "Nina",
  "Omar",
  "Priya",
  "Sam",
  "Tara",
  "Uma",
  "Vik",
];
const SURNAME = [
  "Chen",
  "Garcia",
  "Smith",
  "Okafor",
  "Singh",
  "Kim",
  "Rossi",
  "Novak",
  "Silva",
  "Dubois",
  "Meyer",
  "Lopez",
];
const CITIES: Record<string, [string, string][]> = {
  US: [
    ["Austin", "TX"],
    ["Portland", "OR"],
    ["Denver", "CO"],
    ["Columbus", "OH"],
  ],
  GB: [
    ["Leeds", "ENG"],
    ["Bristol", "ENG"],
  ],
  DE: [
    ["Hamburg", "HH"],
    ["Leipzig", "SN"],
  ],
  FR: [
    ["Lyon", "ARA"],
    ["Nantes", "PDL"],
  ],
  CA: [
    ["Calgary", "AB"],
    ["Halifax", "NS"],
  ],
  AU: [
    ["Perth", "WA"],
    ["Brisbane", "QLD"],
  ],
};

/** Deterministic from the account id, so the seeded random stream is untouched. */
function buyerProfile(account: string, country: string) {
  let h = 0;
  for (const c of account) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const list = CITIES[country] ?? CITIES["US"]!;
  const [city, state] = list[h % list.length]!;
  return {
    account_status:
      h % 5 === 0 ? ("UNVERIFIED" as const) : ("VERIFIED" as const),
    address: { city, state, country_code: country },
  };
}

const COUNTRY = ["US", "US", "US", "GB", "DE", "FR", "CA", "AU"];
const SUBJECTS = [
  "Order",
  "Subscription",
  "Digital download",
  "Gift card",
  "Workshop ticket",
  "Hardware kit",
  "Course",
];
const CURRENCIES = [
  ["USD", 70],
  ["EUR", 18],
  ["GBP", 12],
] as const;
const DAY = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString();

export function seedTransactions(
  rng: Prng,
  cfg: MockConfig,
): TransactionDetail[] {
  const out: TransactionDetail[] = [];
  const span = cfg.seedDays * DAY;
  for (let i = 0; i < cfg.seedTransactions; i++) {
    const code = rng.weighted([
      ["T0006", 85],
      ["T1107", 8],
      ["T1201", 4],
      ["T0000", 3],
    ] as const);
    const currency = rng.weighted(CURRENCIES);
    // long tail: mostly small carts, a few near 900
    const dollars = 5 + Math.pow(rng.next(), 3) * 895;
    const cents = Math.round(dollars * 100);
    const when = cfg.now - Math.floor(rng.next() * span);
    const given = rng.pick(GIVEN);
    const surname = rng.pick(SURNAME);
    const signed =
      code === "T0006" ? cents : code === "T0000" ? -cents : -cents;
    const fee = code === "T0006" ? paypalFeeCents(cents) : 0;
    const id = rng.id(17);
    const account = rng.id(13);
    const country = rng.pick(COUNTRY);
    const prof = buyerProfile(account, country);
    out.push({
      transaction_info: {
        paypal_account_id: "MOCKMERCHANT01",
        transaction_id: id,
        transaction_event_code: code,
        transaction_initiation_date: iso(when),
        transaction_updated_date: iso(when),
        transaction_amount: money(signed, currency),
        fee_amount: money(-fee, currency),
        transaction_status: "S",
        transaction_subject: `${rng.pick(SUBJECTS)} #${rng.int(1000, 9999)}`,
        invoice_id: `INV-${rng.int(100000, 999999)}`,
      },
      payer_info: {
        account_id: account,
        email_address: `${given}.${surname}@example.com`.toLowerCase(),
        payer_name: { given_name: given, surname },
        country_code: country,
        account_status: prof.account_status,
      },
      shipping_info: {
        name: `${given} ${surname}`,
        address: prof.address,
      },
      cart_info: { item_details: [] },
    });
  }
  out.sort(
    (a, b) =>
      Date.parse(a.transaction_info.transaction_initiation_date) -
        Date.parse(b.transaction_info.transaction_initiation_date) ||
      a.transaction_info.transaction_id.localeCompare(
        b.transaction_info.transaction_id,
      ),
  );
  return out;
}

const CARRIERS = ["UPS", "USPS", "FedEx", "DHL"];

/** Buyer message templates per reason. Varied words feed full-text search. */
const BUYER_MESSAGES: Record<string, readonly string[]> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: [
    "My order never arrived and the tracking has not updated in two weeks.",
    "The package was marked delivered but nothing was left at my address.",
    "I paid for {item} over a week ago and have received nothing. Please refund me.",
    "Never arrived. The seller stopped answering my messages about shipping.",
  ],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: [
    "The item arrived broken and the box was crushed.",
    "I ordered {item} but the wrong size was sent. It does not fit.",
    "The product does not match the listing photos and is clearly a different model.",
    "Item is damaged and missing parts that the description promised.",
  ],
  UNAUTHORISED: [
    "I did not authorise this payment. I have never heard of this seller.",
    "This charge is fraud, someone used my account without my permission.",
    "I did not authorise {item}; my card was stolen last month.",
  ],
  DUPLICATE_TRANSACTION: [
    "I was charged twice for the same order. Please reverse one payment.",
    "Charged twice for {item}, both payments went through on the same day.",
    "Duplicate charge on my statement for one purchase.",
  ],
  CREDIT_NOT_PROCESSED: [
    "I returned the item weeks ago and the refund never appeared.",
    "The seller promised a credit for {item} but it has not been processed.",
    "Still waiting on my refund after the return was delivered back to you.",
  ],
  CANCELED_RECURRING_BILLING: [
    "I cancelled my subscription but I was charged again this month.",
    "Cancelled subscription before renewal, yet the charge for {item} went through.",
    "I asked to cancel recurring billing and was billed anyway.",
  ],
  INCORRECT_AMOUNT: [
    "The amount charged is higher than the price I agreed to for {item}.",
    "I was billed more than the invoice total.",
  ],
  OTHER: [
    "There is a problem with this payment and I need help resolving it.",
    "I am unhappy with {item} and the seller has not helped.",
  ],
};
const FOLLOW_UPS: readonly [string, string][] = [
  [
    "SELLER",
    "We shipped your order with tracking and it shows as delivered. Please check with neighbours.",
  ],
  [
    "BUYER",
    "I checked everywhere. The delivered scan is not at my door and I want my money back.",
  ],
  [
    "SELLER",
    "We are sorry to hear that. Can you send a photo of the item and the packaging?",
  ],
  ["BUYER", "I already contacted you twice with photos and got no reply."],
  [
    "SELLER",
    "Our records show the order was fulfilled on time and the tracking number was emailed.",
  ],
];

/** Chance (percent) that the seller wins, by reason; evidence on file helps, UNAUTHORISED is hard. */
function sellerWinPct(reason: DisputeReason, hasEvidence: boolean): number {
  const base: Partial<Record<DisputeReason, number>> = {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 45,
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 35,
    UNAUTHORISED: 20,
    DUPLICATE_TRANSACTION: 30,
    CREDIT_NOT_PROCESSED: 30,
    CANCELED_RECURRING_BILLING: 40,
  };
  const b = base[reason] ?? 35;
  return Math.min(95, b + (hasEvidence ? 30 : 0));
}

export function seedDisputes(
  rng: Prng,
  cfg: MockConfig,
  txns: TransactionDetail[],
): Dispute[] {
  const payments = txns.filter(
    (t) => t.transaction_info.transaction_event_code === "T0006",
  );
  const out: Dispute[] = [];
  const used = new Set<number>();
  const n = Math.min(cfg.seedDisputes, payments.length);
  while (out.length < n) {
    const idx = rng.int(0, payments.length - 1);
    if (used.has(idx)) continue;
    used.add(idx);
    const t = payments[idx]!.transaction_info;
    const p = payments[idx]!.payer_info;
    const status = rng.weighted<DisputeStatus>([
      ["WAITING_FOR_SELLER_RESPONSE", 35],
      ["UNDER_REVIEW", 10],
      ["OPEN", 8],
      ["WAITING_FOR_BUYER_RESPONSE", 7],
      ["RESOLVED", 40],
    ]);
    const paid = Date.parse(t.transaction_initiation_date);
    const created = Math.min(cfg.now - 3600_000, paid + rng.int(1, 10) * DAY);
    const updated = Math.min(cfg.now, created + rng.int(0, 5) * DAY);
    const id = `PP-D-${rng.int(10_000_000, 99_999_999)}${rng.int(10, 99)}`;
    const amountCents = Math.round(Number(t.transaction_amount.value) * 100);
    const currency = t.transaction_amount.currency_code;
    const needsSeller =
      status === "WAITING_FOR_SELLER_RESPONSE" || status === "OPEN";
    const due = needsSeller
      ? cfg.now + rng.int(1, 20) * DAY + rng.int(0, 23) * 3600_000
      : undefined;
    const reason = rng.pick(DISPUTE_REASONS);
    const subject = t.transaction_subject ?? "Order";
    const qty = rng.int(1, 3);
    const stage = rng.weighted([
      ["INQUIRY", 50],
      ["CHARGEBACK", 40],
      ["PRE_ARBITRATION", 7],
      ["ARBITRATION", 3],
    ] as const);
    const buyerName = `${p.payer_name.given_name} ${p.payer_name.surname}`;
    const templates = BUYER_MESSAGES[reason] ?? BUYER_MESSAGES["OTHER"]!;
    const buyerText = rng.pick(templates).replaceAll("{item}", subject);
    const trackable =
      reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" ||
      reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
    const hasEvidence = trackable && rng.next() < 0.4;
    const evidences: Evidence[] = hasEvidence
      ? [
          {
            evidence_type: "PROOF_OF_FULFILLMENT",
            evidence_info: {
              tracking_info: [
                {
                  carrier_name: rng.pick(CARRIERS),
                  tracking_number: rng.id(12),
                },
              ],
            },
            notes: `Shipped ${subject} with tracking; delivery confirmation attached.`,
          },
        ]
      : [];
    const messages: Dispute["messages"] = [
      { posted_by: "BUYER", time_posted: iso(created), content: buyerText },
    ];
    if (rng.next() < 0.45) {
      const [who, text] = rng.pick(FOLLOW_UPS);
      messages.push({
        posted_by: who as "BUYER" | "SELLER",
        time_posted: iso(Math.min(cfg.now, created + rng.int(1, 3) * DAY)),
        content: text,
      });
    }
    let outcome: Pick<Dispute, "outcome" | "dispute_outcome"> = {};
    if (status === "RESOLVED") {
      const sellerWon = rng.int(1, 100) <= sellerWinPct(reason, hasEvidence);
      outcome = sellerWon
        ? {
            outcome: "RESOLVED_SELLER_FAVOUR",
            dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" },
          }
        : {
            outcome: "RESOLVED_BUYER_FAVOUR",
            dispute_outcome: {
              outcome_code: "RESOLVED_BUYER_FAVOUR",
              amount_refunded: money(amountCents, currency),
            },
          };
    }
    const d: Dispute = {
      dispute_id: id,
      create_time: iso(created),
      update_time: iso(updated),
      reason,
      status,
      dispute_state: DISPUTE_STATE[status],
      dispute_amount: money(amountCents, currency),
      dispute_life_cycle_stage: stage,
      dispute_channel: rng.pick(["INTERNAL", "EXTERNAL"] as const),
      ...outcome,
      disputed_transactions: [
        {
          seller_transaction_id: t.transaction_id,
          create_time: t.transaction_initiation_date,
          transaction_status: "COMPLETED",
          gross_amount: money(amountCents, currency),
          buyer: { name: buyerName },
          seller: { merchant_id: "MOCKMERCHANT01", name: "Mock Merchant" },
          items: [{ item_description: subject, item_quantity: String(qty) }],
        },
      ],
      ...(due ? { seller_response_due_date: iso(due) } : {}),
      messages,
      evidences,
      links: [],
    };
    out.push(d);
  }
  return out;
}
