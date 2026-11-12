import type { Llm } from "@jeirslab/llm-client";
import type { DecideOptions } from "./decide-client.js";
import { createHash } from "node:crypto";
import {
  LABEL_TEMPLATE,
  draftResponse,
  fallbackDraft,
  markAdded,
  withAdded,
} from "./draft.js";
import type { Added, CaseView, Decision, Draft, Precedent } from "./types.js";

/**
 * In-memory (per pod) cache of AI drafts. The response text is keyed by case, its last update
 * and the call; the knobs only change the numbers, so a different knob value reuses the text.
 */
interface Entry {
  draft: Draft;
  knobs: string;
}
const MAX = 500;

export class DraftCache {
  private done = new Map<string, Entry>();
  private pending = new Map<string, Promise<Draft>>();
  /** outcome of the last real completion; null until one ran */
  lastOk: boolean | null = null;
  /** called after every real completion, so the page can re-probe at once on a failure */
  onResult?: (ok: boolean) => void;
  /** called with the USD a real draft cost, so the caller can add it to the case's total */
  onCost?: (disputeId: string, usd: number) => void;

  /** the stored source of each case's latest draft, so a first edit is labelled by what it edits */
  readonly lastSource = new Map<string, "llm" | "fallback" | "grounded">();

  constructor(private llm: Llm) {}

  clear(): void {
    this.done.clear();
    this.pending.clear();
    this.lastSource.clear();
  }

  async get(
    c: CaseView,
    decision: Decision | null,
    precedents: Precedent[],
    o: DecideOptions,
    added?: Added[],
  ): Promise<Draft> {
    const extra = added?.length
      ? createHash("sha256")
          .update(JSON.stringify(added))
          .digest("hex")
          .slice(0, 12)
      : "";
    const key = `v7|${c.dispute_id}|${c.updated_at}|${decision?.call ?? "none"}|${extra}`;
    const knobs = `${o.prior ?? ""}|${o.handlingCostCents ?? ""}|${o.feeIfLostCents ?? ""}`;
    // Parley would not fight it, so there is nothing for the model to draft
    if (decision && decision.call !== "fight") {
      const fb = fallbackDraft(
        withAdded(c, added),
        decision,
        o.handlingCostCents,
      );
      return {
        ...fb,
        checklist: markAdded(fb.checklist, added),
        source: "fallback",
        label: LABEL_TEMPLATE,
      };
    }
    const hit = this.done.get(key);
    if (hit) {
      const fb = fallbackDraft(
        withAdded(c, added),
        decision,
        o.handlingCostCents,
      );
      return hit.knobs === knobs
        ? { ...hit.draft, checklist: markAdded(fb.checklist, added) }
        : {
            ...hit.draft,
            checklist: markAdded(fb.checklist, added),
            explanation: fb.explanation,
          };
    }
    const flight = this.pending.get(key + knobs);
    if (flight) return flight;
    const p = (async () => {
      const d = await draftResponse(
        this.llm,
        c,
        decision,
        precedents,
        o.handlingCostCents,
        added,
      );
      this.lastOk = d.fallback_reason !== "ai_down";
      this.lastSource.set(
        c.dispute_id,
        d.source === "llm"
          ? "llm"
          : d.fallback_reason === "grounding"
            ? "grounded"
            : "fallback",
      );
      this.onResult?.(this.lastOk);
      if (d.cost_usd) this.onCost?.(c.dispute_id, d.cost_usd);
      if (d.fallback_reason !== "ai_down") {
        if (this.done.size >= MAX) this.done.clear();
        this.done.set(key, { draft: d, knobs });
      }
      return d;
    })().finally(() => this.pending.delete(key + knobs));
    this.pending.set(key + knobs, p);
    return p;
  }
}

/** Runs fn over items, at most `n` at a time; stops early when fn returns false. */
export async function pool<T>(
  items: T[],
  n: number,
  fn: (x: T) => Promise<boolean>,
): Promise<void> {
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < items.length) {
      if (!(await fn(items[next++]!))) stop = true;
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

/** For pool(): keep going until `n` drafts in a row found the gateway down; one slow call or a grounding fallback never stops it. */
export function stopAfterDown(n = 2): (d: Draft) => boolean {
  let downs = 0;
  return (d) => {
    downs = d.fallback_reason === "ai_down" ? downs + 1 : 0;
    return downs < n;
  };
}
