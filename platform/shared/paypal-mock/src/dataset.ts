import { readFileSync } from "node:fs";
import type { Dispute, TransactionDetail } from "@jeirslab/paypal-client/types";

export interface DemoDataset {
  version: number;
  /** the instant the file's dates are relative to */
  anchor: string;
  merchant: Record<string, unknown>;
  products: Record<string, unknown>[];
  buyers: Record<string, unknown>[];
  transactions: TransactionDetail[];
  disputes: Dispute[];
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

/** Shifts every ISO timestamp in the tree by deltaMs, so "now" is the dataset's anchor moved to the present. */
function shift<T>(v: T, deltaMs: number): T {
  if (typeof v === "string")
    return (
      ISO.test(v) ? new Date(Date.parse(v) + deltaMs).toISOString() : v
    ) as T;
  if (Array.isArray(v)) return v.map((x) => shift(x, deltaMs)) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, shift(x, deltaMs)]),
    ) as T;
  return v;
}

export function loadDataset(path: string, nowMs: number): DemoDataset {
  const raw = JSON.parse(readFileSync(path, "utf8")) as DemoDataset;
  if (!Array.isArray(raw.transactions) || !Array.isArray(raw.disputes))
    throw new Error(`MOCK_SEED_FILE ${path}: not a demo dataset`);
  return shift(raw, nowMs - Date.parse(raw.anchor));
}
