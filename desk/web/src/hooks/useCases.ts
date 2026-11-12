import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type CaseSummary, type Summary } from "../lib/api";
import { isWaiting, needsResponse, sentence } from "../lib/format";

export const byDue = (a: CaseSummary, b: CaseSummary) =>
  (Date.parse(a.due_at ?? "") || Infinity) -
  (Date.parse(b.due_at ?? "") || Infinity);
export const missedDeadline = (c: CaseSummary) =>
  needsResponse(c) && !!c.due_at && Date.parse(c.due_at) < Date.now();
export const needing = (cases: CaseSummary[]) =>
  cases.filter((c) => needsResponse(c) && !missedDeadline(c)).sort(byDue);
export const waitingList = (cases: CaseSummary[]) =>
  cases.filter(isWaiting).sort(byDue);
export const missedList = (cases: CaseSummary[]) =>
  cases.filter(missedDeadline).sort(byDue);
// the soonest-due case recommended for a fight, else the first card shown
export const urgentCase = (cases: CaseSummary[]) =>
  needing(cases).find((c) => String(c.call ?? "").startsWith("fight"));

// every bucket of the summary, so the numbers add up to the total
const KNOWN = ["total", "needs_response", "under_review", "closed"];
export function buckets(sm: Summary): [number, string][] {
  const out: [number, string][] = [
    [sm.needs_response, "need your response"],
    [sm.under_review, "under review"],
    [sm.closed, "closed"],
  ];
  let sum = KNOWN.slice(1).reduce((t, k) => t + (Number(sm[k]) || 0), 0);
  for (const [k, v] of Object.entries(sm)) {
    if (KNOWN.includes(k) || typeof v !== "number" || /cents|soon/.test(k))
      continue;
    out.push([
      v,
      k === "waiting_on_buyer"
        ? "waiting on the buyer"
        : sentence(k).toLowerCase(),
    ]);
    sum += v;
  }
  if (sm.total > sum) out.push([sm.total - sum, "in other states"]);
  return out.filter(([n]) => n > 0);
}
export const bucketLine = (sm: Summary) =>
  buckets(sm)
    .map(([n, l]) => `${n} ${l}`)
    .join(", ");

export function useCases() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failure, setFailure] = useState<{ status: number } | null>(null);
  const retried = useRef(false);
  const reload = useCallback(async () => {
    const r = await api<{ cases: CaseSummary[]; summary?: Summary }>(
      "/api/cases",
    );
    setCases(r.cases);
    setSummary(r.summary ?? null);
    setFailure(null);
    // decide may still be analysing on first load: one retry after 5 s
    if (!retried.current && needing(r.cases).some((c) => !c.call)) {
      retried.current = true;
      setTimeout(() => reload().catch(() => {}), 5000);
    }
  }, []);
  // two quick retries (0.4 s, 0.8 s) ride out the shared mock restarting
  const load = useCallback(async () => {
    for (let i = 0; ; i++) {
      try {
        return await reload();
      } catch (e) {
        if (i === 2)
          return setFailure({ status: e instanceof ApiError ? e.status : 0 });
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
  }, [reload]);
  useEffect(() => void load(), [load]);
  return { cases, summary, error: !!failure, failure, retry: load, reload };
}
