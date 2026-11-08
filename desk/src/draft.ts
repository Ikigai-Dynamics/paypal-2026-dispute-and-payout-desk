import type { Llm } from "@jeirslab/llm-client";
import { DEFAULT_HANDLING_CENTS } from "./decide-client.js";
import type {
  CaseView,
  ChecklistItem,
  Decision,
  Draft,
  Precedent,
} from "./types.js";

export const SYSTEM_PROMPT =
  "You write the seller's reply to a buyer's PayPal claim, on behalf of the merchant named in the input (first person plural, 'we'). " +
  "Write 90 to 160 words in plain, polite, factual prose that a PayPal reviewer can read in one pass. " +
  "Address the buyer's own complaint from their messages, name the items and the amount, and use the merchant name once. " +
  "Cite only evidence present in the input: quote tracking numbers verbatim and refer to the evidence notes on file; " +
  "never invent numbers, dates, carriers or tracking, and if something is missing say plainly that we are still gathering it. " +
  "Never write the dispute id, a reason code, the words 'unauthorised' or 'unauthorized', or any internal field name; " +
  "describe the complaint in everyday words instead (for example 'you did not recognise this payment'). " +
  'Return JSON {"response": string, "explanation": string}. ' +
  "The explanation is one plain sentence in the form 'We recommend fighting because ...' or 'We recommend accepting because ...', " +
  "built from the decision facts given (call, win chance, similar cases, margin in dollars), with no formulas and no variable names such as p, c or EV.";

const words = (s: string) => s.toLowerCase().replaceAll("_", " ");
const money = (c: number, cur: string) => `${cur} ${(c / 100).toFixed(2)}`;

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
    case "DUPLICATE_TRANSACTION":
      return [
        item(
          "Proof the two charges are separate orders",
          notesMatch(c, /separate|two orders|different order|order number/i),
          "An evidence note shows the two charges are separate orders.",
          "Nothing on file shows the two charges are separate orders.",
        ),
        item(
          "Refund issued for the duplicate",
          notesMatch(c, /refund/i),
          "An evidence note refers to a refund.",
          "No refund for the duplicate is on file.",
        ),
      ];
    case "CREDIT_NOT_PROCESSED":
      return [
        item(
          "Return received record",
          notesMatch(c, /return/i),
          "An evidence note refers to the returned item.",
          "No record of the returned item is on file.",
        ),
        item(
          "Refund issued",
          notesMatch(c, /refund/i),
          "An evidence note refers to a refund.",
          "No refund is on file.",
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

const cash = (cents: number, cur: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cur,
    minimumFractionDigits: Math.abs(cents) % 100 === 0 ? 0 : 2,
  }).format(Math.abs(cents) / 100);

/** One plain sentence built from the decision inputs: win chance, what a loss costs, what fighting costs. */
export function explanationOf(
  decision: Decision | null,
  c: Pick<CaseView, "currency" | "amount_cents">,
  handlingCents = DEFAULT_HANDLING_CENTS,
): string {
  if (!decision)
    return "The decision core was unreachable, so no recommendation is shown.";
  const chance = `about ${Math.round(decision.p * 100)}% chance of winning`;
  const cost = cash(handlingCents, c.currency);
  if (decision.call === "fight")
    return `We recommend fighting: ${chance}, a loss costs you only the refund you would give anyway, and fighting costs about ${cost}.`;
  return handlingCents >= c.amount_cents
    ? `We recommend accepting: ${chance}; fighting costs about ${cost}, more than the ${cash(c.amount_cents, c.currency)} you could win back.`
    : `We recommend accepting: ${chance}, which is too low to justify the cost of about ${cost} to fight.`;
}

/** Deterministic template per reason. Cites only what the case holds. */
export function fallbackDraft(
  c: CaseView,
  decision: Decision | null,
  handlingCents?: number,
): Omit<Draft, "source" | "label"> {
  const items =
    c.items
      .map((i) => `${i.item_quantity} × ${i.item_description}`)
      .join(", ") || "the order";
  const amount = money(c.amount_cents, c.currency);
  const tracking = trackingOf(c);
  const head = `We are ${c.merchant} responding to ${c.buyer}'s claim about ${items} (${amount}).`;
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
        "We are checking our order, payment and delivery records for this purchase and will attach what supports it. If we find a mistake on our side, we will refund the buyer.";
  }
  return {
    response: `${head} ${body}`,
    checklist: buildChecklist(c),
    explanation: explanationOf(decision, c, handlingCents),
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

const LEAK = /PP-D-|unauthori[sz]ed|\b[A-Z]{3,}_[A-Z_]{3,}\b/i;

export async function draftResponse(
  llm: Llm,
  c: CaseView,
  decision: Decision | null,
  precedents: Precedent[],
  handlingCents?: number,
): Promise<Draft> {
  const fb = fallbackDraft(c, decision, handlingCents);
  const user = JSON.stringify({
    merchant: c.merchant,
    buyer: c.buyer,
    claim: words(c.reason).replace("unauthorised", "payment not recognised"),
    amount: money(c.amount_cents, c.currency),
    items: c.items.map((i) => `${i.item_quantity} × ${i.item_description}`),
    messages: c.messages.map((m) => ({ from: m.posted_by, text: m.content })),
    evidence_on_file: c.evidences.map((e) => ({
      type: words(e.evidence_type),
      notes: e.notes ?? null,
      tracking: (e.evidence_info?.tracking_info ?? []).map(
        (t) => `${t.carrier_name} ${t.tracking_number}`,
      ),
    })),
    decision: decision && {
      call: decision.call,
      win_chance_percent: Math.round(decision.p * 100),
      similar_cases: decision.n,
      margin_dollars: Math.abs(decision.margin_cents) / 100,
    },
    similar_past_cases: precedents.slice(0, 3).map((p) => ({
      outcome: p.won ? "won by seller" : "lost by seller",
      note: p.snippet,
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
    if (isDraftShape(r.value) && !LEAK.test(r.value.response))
      return {
        response: r.value.response,
        // the computed checklist is the truth the page gates on
        checklist: fb.checklist,
        explanation: r.value.explanation,
        source: "llm",
        label: r.label,
        ...(r.model ? { model: r.model } : {}),
      };
    return {
      ...fb,
      source: "fallback",
      label: "offline fallback",
      error: isDraftShape(r.value)
        ? "LLM reply named an internal id or code"
        : "LLM reply did not match the draft shape",
    };
  }
  return {
    ...fb,
    source: "fallback",
    label: r.label,
    ...(r.error ? { error: r.error } : {}),
  };
}
