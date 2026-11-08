import type { Llm } from "@jeirslab/llm-client";
import { DEFAULT_HANDLING_CENTS } from "./decide-client.js";
import type {
  Added,
  BuyerOrder,
  CaseView,
  ChecklistItem,
  Decision,
  Draft,
  Precedent,
} from "./types.js";

export const SYSTEM_PROMPT =
  "You write the merchant's written response to PayPal's dispute reviewer. It is not a letter to the buyer. " +
  "Write as the merchant named in the input, using 'we'. " +
  "Start with exactly 'Re: <buyer>'s claim about <items> (<amount>)' using the buyer, items and amount from the input, then continue in plain, factual prose. " +
  "No salutation and no 'Dear ...'. Write 90 to 160 words. " +
  "Answer the buyer's own complaint from their messages. " +
  "Cite only the evidence in evidence_on_file: quote tracking numbers and notes faithfully, and treat entries typed 'added by the merchant' as evidence we are enclosing. " +
  "Never invent numbers, dates, carriers, tracking, order ids or any fact that is not in the input. " +
  "Never use square-bracket placeholders. Never give a recommendation, odds or an opinion on how PayPal should rule beyond asking it to find in our favour. " +
  "Never write the dispute id, a reason code, the words 'unauthorised' or 'unauthorized', or any internal field name. " +
  'Return JSON {"response": string} and nothing else.';

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

export const DIGITAL =
  /gift card|e-?gift|voucher|code|download|digital|licen[cs]e|subscription/i;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const orderLine = (o: BuyerOrder, cur: string) =>
  `${day(o.date)}, ${new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(o.amount_cents / 100)} (${o.items})`;
/** The evidence note that already speaks of the billing address, quoted. */
const addressNote = (c: CaseView) => {
  const n = c.evidences.find((e) =>
    /billing address/i.test(e.notes ?? ""),
  )?.notes;
  return n ? `"${n}"` : undefined;
};

/** The per-reason checklist, computed from what is actually on the case. */
export function buildChecklist(c: CaseView): ChecklistItem[] {
  const item = (
    name: string,
    present: boolean,
    yes: string,
    no: string,
    suggestion?: ChecklistItem["suggestion"] | false | undefined | "" | 0,
  ): ChecklistItem => ({
    item: name,
    status: present ? "present" : "missing",
    why: present ? yes : no,
    ...(!present && suggestion ? { suggestion } : {}),
  });
  const tracking = trackingOf(c);
  const digital = c.items.some((i) => DIGITAL.test(i.item_description));
  // the seller's own thread says the code was emailed
  const emailed =
    c.purchased_at &&
    c.messages.some(
      (m) => m.posted_by === "SELLER" && /e-?mail/i.test(m.content),
    );
  switch (c.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      if (digital)
        return [
          item(
            "Proof the code was sent (email log)",
            notesMatch(c, /email|sent|deliver/i),
            "An evidence note refers to the email the code was sent in.",
            "No email log for the code is on file.",
            emailed && {
              label: `Attach email log: code sent ${day(c.purchased_at!)}`,
              note: `The ${c.items.some((i) => /gift/i.test(i.item_description)) ? "gift card " : ""}code was emailed to the buyer's PayPal email address on ${day(c.purchased_at!)}, the day of purchase.`,
            },
          ),
          item(
            "Code redemption record",
            notesMatch(c, /redeem/i),
            "An evidence note refers to the code being redeemed.",
            "No redemption record for the code is on file.",
          ),
        ];
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
          addressNote(c) && {
            label: "Attach address match from the shipment record",
            note: addressNote(c)!,
          },
        ),
        item(
          "Prior orders from this buyer",
          notesMatch(c, /prior order|previous order|earlier order|repeat/i),
          "An evidence note refers to earlier orders.",
          "No order history is on file.",
          !!c.buyer_history?.length && {
            label: `Attach order history: ${c.buyer_history.length} earlier order${c.buyer_history.length > 1 ? "s" : ""}`,
            note: `${c.buyer} has ${c.buyer_history.length} earlier order${c.buyer_history.length > 1 ? "s" : ""} with us on this PayPal account: ${c.buyer_history.map((o) => orderLine(o, c.currency)).join("; ")}.`,
          },
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

const sentence = (t: string) => t.trim().replace(/[.\s]+$/, "") + ".";

/** Deterministic template per reason: what we did, then the evidence on file quoted. Cites only what is present. */
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
  const head = `Re: ${c.buyer}'s claim about ${items} (${amount}).`;
  const did: string = (() => {
    switch (c.reason) {
      case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
        return tracking.length
          ? `We shipped the order and attach the tracking: ${tracking.map((t) => `${t.carrier} ${t.number}`).join("; ")}.`
          : "We fulfilled the order as placed.";
      case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
        return `We believe ${items} matched the listing, and we are happy to discuss a return under our return policy.`;
      case "UNAUTHORISED":
        return "We fulfilled this order as placed on the buyer's PayPal account.";
      case "DUPLICATE_TRANSACTION":
        return "We checked our records for both charges and will refund the second one if it was placed in error.";
      case "CREDIT_NOT_PROCESSED":
        return "We checked our records for the returned item and will refund any amount we owe.";
      case "CANCELED_RECURRING_BILLING":
        return "We checked whether the cancellation reached us before the renewal and will refund any charge made after it.";
      default:
        return "We fulfilled this order and checked our payment records for it.";
    }
  })();
  const cited = c.evidences.flatMap((e) => [
    ...(e.notes ? [sentence(e.notes)] : []),
    ...(c.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
      ? []
      : (e.evidence_info?.tracking_info ?? []).map(
          (t) => `${t.carrier_name} tracking number ${t.tracking_number}.`,
        )),
  ]);
  const body = [
    did,
    ...(cited.length ? ["The enclosed evidence supports this:", ...cited] : []),
    "We ask PayPal to find in our favour.",
  ].join(" ");
  return {
    response: `${head} ${body}`,
    checklist: buildChecklist(c),
    explanation: explanationOf(decision, c, handlingCents),
  };
}

/** The case with evidence the merchant typed in appended, as the drafting sees it. */
export function withAdded(c: CaseView, added: Added[] = []): CaseView {
  return added.length
    ? {
        ...c,
        evidences: [
          ...c.evidences,
          ...added.map((a) => ({
            evidence_type: "ADDED_BY_THE_MERCHANT",
            evidence_info: {},
            notes: `${a.item}: ${a.note}`,
          })),
        ],
      }
    : c;
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

/** Why a response must not be shown, or null. `input` is the JSON the model was given. */
export function invalidReason(response: string, input: string): string | null {
  if (LEAK.test(response)) return "it named an internal id or code";
  const invented = (response.match(/\d{4,}|\b[A-Za-z0-9]{10,}\b/g) ?? []).find(
    (t) => (/^\d+$/.test(t) || /\d/.test(t)) && !input.includes(t),
  );
  if (invented) return `it contained "${invented}", which is not in the input`;
  if (/\[[^\]]{1,40}\]/.test(response))
    return "it contained a square-bracket placeholder";
  if (/\bdear\b/i.test(response))
    return "it addressed the buyer; it is for PayPal's reviewer";
  if (
    /recommend|similar (past )?cases|chance of winning|win chance|expected value/i.test(
      response,
    )
  )
    return "it gave a recommendation or odds";
  return null;
}

export async function draftResponse(
  llm: Llm,
  c0: CaseView,
  decision: Decision | null,
  _precedents: Precedent[],
  handlingCents?: number,
  added?: Added[],
): Promise<Draft> {
  const c = withAdded(c0, added);
  const fb = fallbackDraft(c, decision, handlingCents);
  // no decision and no precedents here: the desk's reasoning must not leak into the response
  const user = JSON.stringify({
    merchant: c.merchant,
    buyer: c.buyer,
    claim: words(c.reason).replace("unauthorised", "payment not recognised"),
    amount: money(c.amount_cents, c.currency),
    ...(c.purchased_at ? { purchased_on: day(c.purchased_at) } : {}),
    items: c.items.map((i) => `${i.item_quantity} × ${i.item_description}`),
    messages: c.messages.map((m) => ({ from: m.posted_by, text: m.content })),
    evidence_on_file: c.evidences.map((e) => ({
      type: words(e.evidence_type),
      notes: e.notes ?? null,
      tracking: (e.evidence_info?.tracking_info ?? []).map(
        (t) => `${t.carrier_name} ${t.tracking_number}`,
      ),
    })),
  });
  const ask = async (content: string) =>
    llm.complete<{ response: string }>(
      {
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        json: true,
        temperature: 0.2,
      },
      () => ({ response: fb.response }),
    );
  let r = await ask(user);
  const check = (v: unknown) => {
    const t = (v as { response?: unknown } | null)?.response;
    return typeof t !== "string" || !t.trim()
      ? "the reply did not match the draft shape"
      : invalidReason(t, user);
  };
  let bad = r.source === "llm" ? check(r.value) : null;
  if (r.source === "llm" && bad) {
    r = await ask(
      `${user}\n\nYour previous answer was rejected because ${bad}. Write it again without that.`,
    );
    bad = r.source === "llm" ? check(r.value) : null;
  }
  if (r.source === "llm" && !bad)
    return {
      response: (r.value as { response: string }).response.trim(),
      // the computed checklist and explanation are the truth the page gates on
      checklist: fb.checklist,
      explanation: fb.explanation,
      source: "llm",
      label: r.label,
      ...(r.model ? { model: r.model } : {}),
    };
  return {
    ...fb,
    source: "fallback",
    label: r.source === "llm" ? "offline fallback" : r.label,
    error: bad ?? r.error ?? "AI draft unavailable",
  };
}
