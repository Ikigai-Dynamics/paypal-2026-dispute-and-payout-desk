import type { Llm } from "@jeirslab/llm-client";
import type {
  CaseView,
  ChecklistItem,
  Decision,
  Draft,
  Precedent,
} from "./types.js";

export const SYSTEM_PROMPT =
  "You write a PayPal dispute response as the merchant (first person plural, 'we'). " +
  "Write 90 to 160 words, polite and factual. Cite only evidence present in the given case and quote tracking numbers verbatim; " +
  "never invent numbers, dates or tracking, and if something is missing say it is missing. " +
  'Return JSON {"response": string, "explanation": string}. ' +
  "The explanation is one plain sentence in the form 'We recommend fighting because ...' or 'We recommend accepting because ...', " +
  "built from the decision facts given (call, win chance, similar cases, margin in dollars), with no formulas and no variable names such as p, c or EV.";

const words = (s: string) => s.toLowerCase().replaceAll("_", " ");
const money = (c: number, cur: string) => `${(c / 100).toFixed(2)} ${cur}`;

export function trackingOf(c: CaseView): { carrier: string; number: string }[] {
  return c.evidences.flatMap((e) =>
    (e.evidence_info?.tracking_info ?? []).map((t) => ({
      carrier: t.carrier_name,
      number: t.tracking_number,
    })),
  );
}

const notesMatch = (c: CaseView, re: RegExp) =>
  c.evidences.some((e) => re.test(`${e.evidence_type} ${e.notes ?? ""}`));

/** The per-reason checklist, computed from what is actually on the case. */
export function buildChecklist(c: CaseView): ChecklistItem[] {
  const item = (
    name: string,
    present: boolean,
    yes: string,
    no: string,
  ): ChecklistItem => ({
    item: name,
    status: present ? "present" : "missing",
    why: present ? yes : no,
  });
  const tracking = trackingOf(c);
  switch (c.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      return [
        item(
          "Tracking number",
          tracking.length > 0,
          `Evidence on file lists ${tracking.map((t) => t.carrier).join(", ")} tracking.`,
          "No tracking information is attached to this case.",
        ),
        item(
          "Delivery confirmation",
          notesMatch(c, /deliver/i),
          "An evidence note refers to delivery confirmation.",
          "No delivery confirmation is on file.",
        ),
      ];
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return [
        item(
          "Listing description",
          notesMatch(c, /listing|description|described/i),
          "An evidence note refers to the listing description.",
          "No item description is on the case.",
        ),
        item(
          "Photos of the item",
          notesMatch(c, /photo|image|picture/i),
          "An evidence note refers to photos.",
          "No photos are on file.",
        ),
        item(
          "Return policy",
          notesMatch(c, /return policy/i),
          "An evidence note refers to the return policy.",
          "The return policy has not been provided.",
        ),
      ];
    case "UNAUTHORISED":
      return [
        item(
          "Shipping address matches the buyer",
          notesMatch(c, /address/i),
          "An evidence note refers to the address match.",
          "No address match is on file.",
        ),
        item(
          "Prior orders from this buyer",
          notesMatch(c, /prior order|previous order|repeat/i),
          "An evidence note refers to earlier orders.",
          "No order history is on file.",
        ),
      ];
    default:
      return [
        item(
          "Proof of fulfilment or service",
          notesMatch(c, /fulfil|fulfill|deliver|service/i) ||
            tracking.length > 0,
          "Evidence on file supports fulfilment.",
          "No proof of fulfilment is on file.",
        ),
        item(
          "Communication with the buyer",
          c.messages.some((m) => m.posted_by === "SELLER"),
          "A seller message is on the thread.",
          "There is no seller message on the thread yet.",
        ),
      ];
  }
}

const dollars = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`;

export function explanationOf(decision: Decision | null): string {
  if (!decision)
    return "The decision core was unreachable, so no recommendation is shown.";
  const chance = `about ${Math.round(decision.p * 100)}% chance of winning`;
  return decision.call === "fight"
    ? `We recommend fighting: ${chance}; fighting is worth about ${dollars(decision.margin_cents)} more than refunding.`
    : `We recommend accepting: ${chance}; fighting would cost about ${dollars(decision.margin_cents)} more than refunding.`;
}

/** Deterministic template per reason. Cites only what the case holds. */
export function fallbackDraft(
  c: CaseView,
  decision: Decision | null,
): Omit<Draft, "source"> {
  const items =
    c.items
      .map((i) => `${i.item_quantity} x ${i.item_description}`)
      .join(", ") || "the order";
  const amount = money(c.amount_cents, c.currency);
  const tracking = trackingOf(c);
  const head = `Hello, this is the seller responding to dispute ${c.dispute_id} (${words(c.reason)}) opened by ${c.buyer} for ${amount}, covering ${items}.`;
  let body: string;
  switch (c.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      body = tracking.length
        ? `We shipped the order and attach the tracking: ${tracking.map((t) => `${t.carrier} ${t.number}`).join("; ")}. The carrier record shows the shipment on its way to the address on the order.`
        : "We have not attached tracking to this case yet and are locating the shipment record. We ask PayPal to allow us time to provide it.";
      break;
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      body = `We believe ${items} matched the listing. ${tracking.length ? `Shipping evidence is attached (${tracking.map((t) => t.carrier).join(", ")}). ` : ""}We are happy to discuss a return under our return policy.`;
      break;
    case "UNAUTHORISED":
      body =
        "We are reviewing whether the order was placed from a known account and matched the buyer's shipping address, and will attach what we find.";
      break;
    case "DUPLICATE_TRANSACTION":
      body =
        "We are checking whether two separate orders were placed. If the second payment was a duplicate, we will refund it.";
      break;
    case "CREDIT_NOT_PROCESSED":
      body =
        "We are checking our records for the returned item and any pending refund, and will confirm the refund status here.";
      break;
    case "CANCELED_RECURRING_BILLING":
      body =
        "We are checking whether the cancellation was received before the renewal date and will refund any charge made after it.";
      break;
    default:
      body =
        "We are reviewing the details of this case and will attach supporting records.";
  }
  return {
    response: `${head} ${body}`,
    checklist: buildChecklist(c),
    explanation: explanationOf(decision),
  };
}

const isChecklist = (x: unknown): x is ChecklistItem[] =>
  Array.isArray(x) &&
  x.every(
    (i) =>
      i &&
      typeof i.item === "string" &&
      (i.status === "present" || i.status === "missing") &&
      typeof i.why === "string",
  );

export function isDraftShape(
  x: unknown,
): x is { response: string; checklist?: ChecklistItem[]; explanation: string } {
  const d = x as Record<string, unknown> | null;
  return (
    !!d &&
    typeof d["response"] === "string" &&
    typeof d["explanation"] === "string" &&
    (d["checklist"] === undefined || isChecklist(d["checklist"]))
  );
}

export async function draftResponse(
  llm: Llm,
  c: CaseView,
  decision: Decision | null,
  precedents: Precedent[],
): Promise<Draft> {
  const fb = fallbackDraft(c, decision);
  const user = JSON.stringify({
    case: {
      dispute_id: c.dispute_id,
      reason: c.reason,
      stage: c.stage,
      amount: money(c.amount_cents, c.currency),
      buyer: c.buyer,
      messages: c.messages,
      items: c.items,
      evidences: c.evidences,
    },
    decision: decision && {
      call: decision.call,
      win_chance_percent: Math.round(decision.p * 100),
      similar_cases: decision.n,
      margin_dollars: Math.abs(decision.margin_cents) / 100,
    },
    decision_terms: decision?.terms ?? [],
    precedents: precedents.slice(0, 3).map((p) => ({
      dispute_id: p.dispute_id,
      outcome: p.outcome,
      snippet: p.snippet,
    })),
  });
  const r = await llm.complete<{ response: string; explanation: string }>(
    {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
      json: true,
      temperature: 0.2,
    },
    () => fb,
  );
  if (r.source === "llm") {
    if (isDraftShape(r.value))
      return {
        response: r.value.response,
        // the computed checklist is the truth the page gates on
        checklist: fb.checklist,
        explanation: r.value.explanation,
        source: "llm",
        ...(r.model ? { model: r.model } : {}),
      };
    return {
      ...fb,
      source: "fallback",
      error: "LLM reply did not match the draft shape",
    };
  }
  return {
    ...fb,
    source: "fallback",
    ...(r.error ? { error: r.error } : {}),
  };
}
