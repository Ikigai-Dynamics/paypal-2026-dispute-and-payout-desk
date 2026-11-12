import type { CaseSummary } from "./api";

export const DAY = 86400000;

const fmts = new Map<string, Intl.NumberFormat>();
// amounts always carry their own currency; whole amounts may drop the cents
export const money = (cents: number, cur = "USD", whole = false) => {
  whole = whole && cents % 100 === 0;
  const k = cur + whole;
  if (!fmts.has(k))
    fmts.set(
      k,
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cur,
        ...(whole ? { minimumFractionDigits: 0 } : {}),
      }),
    );
  return fmts.get(k)!.format(Math.abs(cents) / 100);
};
export const signed = (cents: number, cur: string) =>
  (cents < 0 ? "-" : "") + money(cents, cur);

export const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  OTHER: "Other: the buyer did not say what is wrong",
  PROBLEM_WITH_REMITTANCE: "Payment didn't arrive as expected",
  PAYMENT_BY_OTHER_MEANS: "Buyer says they paid another way",
  CANCELED_RECURRING_BILLING: "Buyer says they cancelled before this charge",
};
// short names for the panel title; the plain sentence goes in the subtitle
export const REASON_SHORT: Record<string, string> = {
  OTHER: "Other",
  PROBLEM_WITH_REMITTANCE: "Payment problem",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  CANCELED_RECURRING_BILLING: "Cancelled subscription",
};
export const sentence = (s: unknown) => {
  const t = String(s ?? "")
    .replaceAll("_", " ")
    .toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const reasonWords = (r: string) => REASONS[r] ?? sentence(r);
export const reasonShort = (r: string) => REASON_SHORT[r] ?? reasonWords(r);

type StatusLike = { status: string; outcome?: string | null };
export const needsResponse = (c: StatusLike) =>
  c.status === "WAITING_FOR_SELLER_RESPONSE" || c.status === "OPEN";
export const statusWords = (c: StatusLike) => {
  if (needsResponse(c)) return "Needs your response";
  if (c.status === "WAITING_FOR_BUYER_RESPONSE") return "Waiting for buyer";
  if (c.status === "UNDER_REVIEW") return "Under review";
  if (c.status === "RESOLVED" || c.outcome)
    return c.outcome === "RESOLVED_SELLER_FAVOUR"
      ? "Resolved: you won"
      : c.outcome === "RESOLVED_BUYER_FAVOUR"
        ? "Resolved: buyer won"
        : "Resolved";
  return sentence(c.status);
};

/** cases we answered and are now waiting on the buyer or PayPal */
export const isWaiting = (c: StatusLike) => c.status === "WAITING_FOR_BUYER_RESPONSE" || c.status === "UNDER_REVIEW";
/** the badge after the seller acted; `kind` is what was just sent, else the status says it */
export const afterSendWords = (kind: "offer" | "accept" | "evidence" | null, c?: StatusLike) =>
  kind === "accept"
    ? "Refunded"
    : kind === "evidence" || c?.status === "UNDER_REVIEW"
      ? "Evidence sent · PayPal reviewing"
      : kind === "offer" || c?.status === "WAITING_FOR_BUYER_RESPONSE"
        ? "Offer sent · waiting for buyer"
        : c
          ? statusWords(c)
          : "Sent";
export const pastCases = (n: number) => `${n} similar past case${n === 1 ? "" : "s"}`;

export type CallKind = "fight" | "accept" | "offer";
// the core's call may read "accept (marginal)"
export const callKind = (call: string | null | undefined): CallKind | null =>
  !call
    ? null
    : call.startsWith("fight")
      ? "fight"
      : call.startsWith("offer")
        ? "offer"
        : "accept";
/** Parley's call as a chip: Fight / Refund / Offer $X */
export const callWords = (c: {
  call?: string | null;
  offer_cents?: number | null;
  currency?: string;
}) => {
  const k = callKind(c.call);
  return k === "fight"
    ? "Fight"
    : k === "offer" && c.offer_cents
      ? `Offer ${money(c.offer_cents, c.currency)}`
      : k
        ? "Refund"
        : "Analysing…";
};
export const reasonIcon = (r: string) =>
  r.includes("NOT_RECEIVED")
    ? "📦"
    : r.includes("NOT_AS_DESCRIBED")
      ? "🔍"
      : r.startsWith("UNAUTH")
        ? "🔒"
        : r.startsWith("DUPLICATE")
          ? "🧾"
          : "💬";
/** "due in 6 days" for the list, "Respond in 6 days" for the case */
export const daysLeft = (iso: string | null) => {
  if (!iso) return null;
  return dayDiff(iso);
};
export const dueWords = (n: number, lead = "due") =>
  n < 0
    ? "overdue"
    : n === 0
      ? `${lead} today`
      : n === 1
        ? `${lead} tomorrow`
        : `${lead} in ${n} days`;

export const dateShort = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const dateLong = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
// calendar days in the browser's timezone, so the label does not depend on the time of day
export const dayDiff = (iso: string) => {
  const mid = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((mid(new Date(iso)) - mid(new Date())) / DAY);
};
export const inDays = (iso: string) => {
  const n = dayDiff(iso);
  return n < 0
    ? "overdue"
    : n === 0
      ? "today"
      : n === 1
        ? "tomorrow"
        : `in ${n} days`;
};
export const dueSoon = (c: { due_at: string | null }) =>
  !!c.due_at && dayDiff(c.due_at) <= 3;

type OrderLike = Pick<CaseSummary, "items" | "item" | "item_quantity">;
export const orderText = (c: OrderLike) => {
  const it = c.items?.length
    ? c.items
    : c.item
      ? [{ item_description: c.item, item_quantity: c.item_quantity ?? 1 }]
      : [];
  const f = (i: { item_description: string; item_quantity: string | number }) =>
    `${i.item_quantity} × ${i.item_description}`;
  return it.length > 2
    ? `${f(it[0]!)} + ${it.length - 1} more`
    : it.map(f).join(" + ");
};

export const pct = (x: number) => Math.round(x * 100);
export const unbracket = (t: unknown) => String(t ?? "").replace(/[[\]]/g, "");
