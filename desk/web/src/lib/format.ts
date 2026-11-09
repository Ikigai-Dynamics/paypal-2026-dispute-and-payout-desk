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

export type Rec = {
  kind: "fight" | "accept" | "marginal" | "unknown";
  base: "fight" | "accept" | null;
  label: string;
  color: string;
};
// call may be "accept (marginal)"; marginal is also a flag on the decision
export function rec(call: string | null | undefined, marginal?: boolean): Rec {
  if (!call)
    return { kind: "unknown", base: null, label: "Analysing…", color: "grey" };
  const base = call.startsWith("fight") ? "fight" : "accept";
  const m = marginal ?? call.includes("marginal");
  if (m)
    return {
      kind: "marginal",
      base,
      label: `Close call: ${base}`,
      color: "amber",
    };
  return {
    kind: base,
    base,
    label: base === "fight" ? "Fight" : "Accept",
    color: base === "fight" ? "green" : "red",
  };
}

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
