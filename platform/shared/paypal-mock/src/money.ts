import type { Money } from "@jeirslab/paypal-client/types";

export const VALUE_RE = /^\d{1,13}\.\d{2}$/;

export function toCents(value: string): number {
  const [w, f] = value.split(".");
  return Number(w) * 100 + Number(f ?? "0");
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export function money(cents: number, currency: string): Money {
  return { currency_code: currency, value: fromCents(cents) };
}

/** Integer division rounded half to even. */
export function roundHalfEven(num: number, den: number): number {
  const q = Math.floor(num / den);
  const r = num - q * den;
  const twice = r * 2;
  if (twice < den) return q;
  if (twice > den) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}

/** PayPal fee: 3.49% + 0.49 (flat, in the order currency), rounded half-even to cents. */
export function paypalFeeCents(amountCents: number): number {
  return roundHalfEven(amountCents * 349, 10000) + 49;
}

/** Payout fee: 2% capped at 20.00. */
export function payoutFeeCents(amountCents: number): number {
  return Math.min(2000, roundHalfEven(amountCents * 2, 100));
}
