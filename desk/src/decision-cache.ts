import type { CaseRow, Decision } from "./types.js";

/** A case's default decision, as the list, the case view, the chat and the KPI all read it. */
export interface CachedDecision {
  at: string;
  /** decide core build + the case's last update: a new build or a changed case recomputes */
  sig: string;
  full: Decision;
  call: string;
  margin_cents: number;
  marginal: boolean;
  offer_cents: number | null;
  p: number;
  p_lo: number;
  p_hi: number;
  keep_cents: number;
}

/**
 * One call per case. `callFor` is the only writer; what-if options never reach it.
 * shortcut: in memory per pod (replicas=1), lost on restart and rebuilt by the boot warm.
 */
export function createDecisionCache(opts: {
  compute: (row: CaseRow) => Promise<Decision | null>;
  build: () => Promise<string>;
}) {
  const map = new Map<string, CachedDecision>();
  const flight = new Map<string, Promise<CachedDecision | null>>();
  const callFor = async (row: CaseRow): Promise<CachedDecision | null> => {
    const sig = `${await opts.build()}|${row.updated_at}`;
    const hit = map.get(row.dispute_id);
    if (hit?.sig === sig) return hit;
    const key = `${row.dispute_id}|${sig}`;
    let p = flight.get(key);
    if (!p) {
      p = (async () => {
        const d = await opts.compute(row);
        if (!d) return null;
        const c: CachedDecision = {
          at: new Date().toISOString(),
          sig,
          full: d,
          call: d.call,
          margin_cents: d.margin_cents,
          marginal: d.marginal,
          offer_cents:
            d.call === "offer" ? (d.offer?.amount_cents ?? null) : null,
          p: d.p,
          p_lo: d.p_lo,
          p_hi: d.p_hi,
          keep_cents: d.keep_cents,
        };
        map.set(row.dispute_id, c);
        return c;
      })().finally(() => flight.delete(key));
      flight.set(key, p);
    }
    return p;
  };
  return {
    callFor,
    get: (id: string) => map.get(id),
    entries: () => map.entries(),
    has: (id: string) => map.has(id),
    drop: (id: string) => void map.delete(id),
    clear: () => map.clear(),
  };
}

/** Whole dollars, as a multiple of 100 cents. */
export const wholeDollarsCents = (cents: number): number =>
  Math.round(cents / 100) * 100;
