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

export const LABEL_AI = "AI draft";
export const LABEL_TEMPLATE = "Template draft (AI unavailable)";
export const LABEL_AI_UPDATED = "AI draft, updated with your evidence";

export const SYSTEM_PROMPT =
  "You write the merchant's written response to PayPal's dispute reviewer. It is not a letter to the buyer. " +
  "Write as the merchant named in the input, using 'we'. No salutation and no 'Dear ...'. " +
  "Write 3 to 5 sentences of plain, factual prose, and do not repeat the buyer's name or the amount in a heading. " +
  "State our_position, which is what we say happened, and argue it. Answer the buyer's own complaint from buyer_messages. " +
  "Cite only facts_on_file, quoting dates, numbers and notes exactly as given. " +
  "Never write a number, carrier, date, order id or document that is not in facts_on_file. " +
  "Never use the words shipped, delivered, enclosed, attached, providing, lack or 'our records' unless facts_on_file says so. " +
  "Never say any evidence is missing or still needed, and never promise to send anything later. If facts_on_file is empty, mention no documents or evidence at all. " +
  "Never agree with the buyer or concede the claim, and never apologise. " +
  "Never use square-bracket placeholders, never give a recommendation or odds, and never write the dispute id, a reason code, or any internal field name. " +
  'Return JSON {"response": string} and nothing else.';

/** What we say happened, built from the dispute reason; the draft argues this and nothing else. */
export const positionOf = (reason: string): string => {
  switch (reason) {
    case "DUPLICATE_TRANSACTION":
      return "The two charges are for two separate orders, not one charge taken twice.";
    case "UNAUTHORISED":
      return "The buyer authorised this payment.";
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return "The item matched its listing.";
    case "CREDIT_NOT_PROCESSED":
      return "We handled this order and any return correctly.";
    default:
      return "The order was fulfilled.";
  }
};
const POSITION_KEY: Record<string, RegExp> = {
  DUPLICATE_TRANSACTION: /separate|two (different )?orders/i,
  UNAUTHORISED: /authori[sz]ed|authori[sz]ation/i,
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: /listing|matched|described/i,
  CREDIT_NOT_PROCESSED: /handled|return|refund/i,
};
// the grounded stand-in position also counts
const positionKey = (reason: string) =>
  new RegExp(
    `${(POSITION_KEY[reason] ?? /fulfil/i).source}|dispute this claim|review whether`,
    "i",
  );

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

const NEUTRAL =
  "We dispute this claim and ask PayPal to review the facts below.";

/** Our position for this case: the reason's claim only when something on file supports it, else a neutral one. */
export function positionFor(c: CaseView): string {
  const tracking = trackingOf(c).length > 0;
  // history we hold but have not attached is not evidence on file
  const history = notesMatch(
    c,
    /other orders?|prior orders?|previous orders?|earlier orders?|repeat/i,
  );
  switch (c.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      return tracking || notesMatch(c, /deliver|\bsent\b|ship/i)
        ? positionOf(c.reason)
        : NEUTRAL;
    case "PAYMENT_BY_OTHER_MEANS":
      return notesMatch(
        c,
        /one payment|single payment|paid (once|through paypal)/i,
      )
        ? "Our records show one payment for this order, through PayPal."
        : "We have no record of another payment for this order.";
    case "UNAUTHORISED":
      return history || addressNote(c)
        ? positionOf(c.reason)
        : "We ask PayPal to review whether this payment was authorised, using the facts below.";
    case "DUPLICATE_TRANSACTION":
      return positionOf(c.reason);
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return notesMatch(c, /listing|description|described/i)
        ? positionOf(c.reason)
        : NEUTRAL;
    case "CREDIT_NOT_PROCESSED":
      return notesMatch(c, /return|refund/i) ? positionOf(c.reason) : NEUTRAL;
    default:
      return tracking || notesMatch(c, /fulfil|deliver|ship|service/i)
        ? positionOf(c.reason)
        : NEUTRAL;
  }
}

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
  // orders that are disputes themselves prove nothing about a good history (analysis sets `disputed`)
  const history = (c.buyer_history ?? []).filter(
    (o) => !(o as BuyerOrder & { disputed?: boolean }).disputed,
  );
  const item = (
    name: string,
    required: boolean,
    present: boolean,
    yes: string,
    no: string,
    suggestion?: ChecklistItem["suggestion"] | false | undefined | "" | 0,
  ): ChecklistItem => ({
    item: name,
    required,
    status: present ? "present" : "missing",
    why: present ? yes : no,
    ...(!present && suggestion ? { suggestion } : {}),
  });
  const tracking = trackingOf(c);
  const order = c.items
    .map((i) => `${i.item_quantity} × ${i.item_description}`)
    .join(", ");
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
            true,
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
            false,
            notesMatch(c, /redeem/i),
            "An evidence note refers to the code being redeemed.",
            "No redemption record for the code is on file.",
          ),
        ];
      return [
        item(
          "Tracking number",
          true,
          tracking.length > 0,
          `Evidence on file lists ${tracking.map((t) => t.carrier).join(", ")} tracking.`,
          "No tracking information is attached to this case.",
        ),
        item(
          "Delivery confirmation",
          false,
          notesMatch(c, /deliver/i),
          "An evidence note refers to delivery confirmation.",
          "No delivery confirmation is on file.",
        ),
      ];
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return [
        item(
          "Listing description",
          true,
          notesMatch(c, /listing|description|described/i),
          "An evidence note refers to the listing description.",
          "No item description is on the case.",
        ),
        item(
          "Photos of the item",
          false,
          notesMatch(c, /photo|image|picture/i),
          "An evidence note refers to photos.",
          "No photos are on file.",
        ),
        item(
          "Return policy",
          false,
          notesMatch(c, /return policy/i),
          "An evidence note refers to the return policy.",
          "The return policy has not been provided.",
        ),
      ];
    case "UNAUTHORISED":
      return [
        item(
          "Shipping address matches the buyer",
          !c.buyer_history?.length,
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
          !!c.buyer_history?.length,
          notesMatch(c, /prior order|previous order|earlier order|repeat/i),
          "An evidence note refers to other orders.",
          "No order history is on file.",
          !!history.length && {
            label: `Attach order history: ${history.length} other order${history.length > 1 ? "s" : ""}`,
            note: `${c.buyer} has ${history.length} other order${history.length > 1 ? "s" : ""} with us on this PayPal account: ${history.map((o) => orderLine(o, c.currency)).join("; ")}.`,
          },
        ),
      ];
    case "DUPLICATE_TRANSACTION":
      return [
        item(
          "Proof the two charges are separate orders",
          true,
          notesMatch(c, /separate|two orders|different order|order number/i),
          "An evidence note shows the two charges are separate orders.",
          "Nothing on file shows the two charges are separate orders.",
          !!c.purchased_at && {
            label: `Attach the order record: ${day(c.purchased_at)}`,
            note: `Order record: ${order || "the order"}, ${money(c.amount_cents, c.currency)}, placed ${day(c.purchased_at)}.`,
          },
        ),
        item(
          "Refund issued for the duplicate",
          false,
          notesMatch(c, /refund/i),
          "An evidence note refers to a refund.",
          "No refund for the duplicate is on file.",
        ),
      ];
    case "CREDIT_NOT_PROCESSED":
      return [
        item(
          "Return received record",
          true,
          notesMatch(c, /return/i),
          "An evidence note refers to the returned item.",
          "No record of the returned item is on file.",
        ),
        item(
          "Refund issued",
          false,
          notesMatch(c, /refund/i),
          "An evidence note refers to a refund.",
          "No refund is on file.",
        ),
      ];
    default:
      return [
        item(
          "Proof of fulfilment or service",
          false,
          notesMatch(c, /fulfil|fulfill|deliver|service/i),
          "Evidence on file supports fulfilment.",
          "No proof of fulfilment is on file.",
          tracking.length > 0 && {
            label: "Attach the tracking details",
            note: `Proof of fulfilment: ${tracking.map((t) => `${t.carrier} tracking number ${t.number}`).join("; ")}.`,
          },
        ),
        item(
          "Communication with the buyer",
          true,
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

/** The opening sentence, always with the buyer's full name. */
export const headOf = (c: CaseView) =>
  `Re: ${c.buyer}'s claim about ${c.items.map((i) => `${i.item_quantity} × ${i.item_description}`).join(", ") || "the order"} (${money(c.amount_cents, c.currency)}).`;

/** Deterministic template per reason: what we did, then the evidence on file quoted. Cites only what is present. */
export function fallbackDraft(
  c: CaseView,
  decision: Decision | null,
  handlingCents?: number,
): Omit<Draft, "source" | "label"> {
  const head = headOf(c);
  const cited = c.evidences.flatMap((e) => [
    ...(e.notes ? [`On file: ${sentence(e.notes)}`] : []),
    ...(e.evidence_info?.tracking_info ?? []).map(
      (t) => `On file: ${t.carrier_name} tracking number ${t.tracking_number}.`,
    ),
  ]);
  const body = [
    positionFor(c),
    ...cited,
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

// [claim in the response, stem that must appear in the proof]
const CLAIMS: [RegExp, RegExp][] = [
  [/\b(shipped|dispatched)\b/i, /ship|dispatch/i],
  [/\bdelivered\b|\bdelivery (was|is) confirmed/i, /deliver/i],
  [/\be-?mailed\b/i, /e-?mail/i],
  [/\bre-?sent\b/i, /re-?sent/i],
  [/\breviewed\b/i, /review/i],
  [
    /\b(our|the|email|delivery)( \w+)? logs\b|\blogs? (show|confirm|indicate)|\bbounce/i,
    /\blogs?\b|bounce/i,
  ],
  [
    /\brecords? (show|confirm|indicate|reflect)|\bour records\b|checked our records/i,
    /record/i,
  ],
  [/\btracking (information|shows?|confirm\w*|details|data)\b/i, /tracking/i],
  [/signature|signed for/i, /signature|signed/i],
  [/\bonly one (order|charge|transaction|payment)\b/i, /only one/i],
  [/\b(has|was|been|were) redeemed\b|\bredeemed (on|by)\b/i, /redeem/i],
];
const MONTH =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/gi;
const dates = (t: string) =>
  [...t.matchAll(MONTH)].map((m) => `${m[1]!.toLowerCase()} ${m[2]}`);

/**
 * Why a response must not be shown, or null. `input` is the JSON the model was given;
 * `proof` is the evidence notes, tracking text and purchase date a claim may rest on.
 */
export function invalidReason(
  response: string,
  input: string,
  proof = input,
): string | null {
  if (LEAK.test(response)) return "it named an internal id or code";
  const invented = (response.match(/\d{4,}|\b[A-Za-z0-9]{10,}\b/g) ?? []).find(
    (t) => (/^\d+$/.test(t) || /\d/.test(t)) && !input.includes(t),
  );
  if (invented) return `it contained "${invented}", which is not in the input`;
  // shortcut: a stem inside a modal or negated phrase ("can be re-sent", "not redeemed") is no proof it was done
  const done = proof.replace(
    /\b(can|could|may|will|would|should)( not)?( be)? [\w-]+|\b(not|never|no)( been)? [\w-]+/gi,
    "",
  );
  const claim = CLAIMS.find(
    ([c, stem]) => c.test(response) && !stem.test(done),
  );
  if (claim)
    return `it claimed "${response.match(claim[0])![0]}", which no evidence note says`;
  const known = dates(proof);
  const date = dates(response).find((d) => !known.includes(d));
  if (date) return `it gave the date "${date}", which is not in the evidence`;
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

const LACK =
  /\b(lack|lacking|lacks|still need|missing|to follow|will provide|will send)\b/i;
const ENCLOSE = /\b(enclosed?|enclosing|attached|providing)\b/i;
const CONCEDE =
  /related to the same transaction|same transaction|charged twice|we apologi|we agree/i;
const NO_EVIDENCE =
  /\b(no|not any) (evidence|documents?|documentation)\b|nothing on file/i;
/** The distinctive words of each checklist item; a sentence using them names that item. */
const ITEM_NOUN: Record<string, RegExp> = {
  "Tracking number": /tracking/i,
  "Delivery confirmation": /delivery confirmation|confirmation of delivery/i,
  "Proof the code was sent (email log)":
    /e-?mail logs?|proof the code was sent/i,
  "Code redemption record": /redemption|redeem/i,
  "Listing description": /listing (description|details|page|screenshot)/i,
  "Photos of the item": /photos?\b/i,
  "Return policy": /return policy/i,
  "Shipping address matches the buyer": /address/i,
  "Prior orders from this buyer":
    /prior orders?|order history|previous orders?|earlier orders?/i,
  "Refund issued for the duplicate": /refund/i,
  "Refund issued": /refund/i,
  "Return received record": /return received|returned item/i,
};

export const sentencesOf = (t: string) =>
  t
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Sentences of the body that claim, concede or name something the case does not support, with the reason. */
function groundingFlags(
  response: string,
  checklist: ChecklistItem[],
  factsText: string,
): { sentence: string; why: string }[] {
  const noFacts = !factsText.trim();
  const ss = sentencesOf(response);
  const enclosing = ss.some((x) => ENCLOSE.test(x));
  const missing = checklist.filter((i) => i.status === "missing");
  const onFile = checklist.filter((i) => i.status === "present");
  const out: { sentence: string; why: string }[] = [];
  for (const x of ss) {
    const why = LACK.test(x)
      ? "it speaks of evidence that is lacking or to follow"
      : CONCEDE.test(x) ||
          (/duplicate charge/i.test(x) && !/\b(not|no|never)\b/i.test(x))
        ? "it concedes the buyer's claim"
        : ENCLOSE.test(x) && !onFile.some((i) => ITEM_NOUN[i.item]?.test(x))
          ? noFacts
            ? "it says documents are enclosed but none are on file"
            : "it says documents are enclosed or provided, which the facts do not show"
          : missing.some((i) => ITEM_NOUN[i.item]?.test(x))
            ? "it names evidence that is not on file"
            : NO_EVIDENCE.test(x)
              ? enclosing
                ? "it says there is no evidence while another sentence encloses some"
                : "it talks about evidence being absent"
              : "";
    if (why) out.push({ sentence: x, why });
  }
  return out;
}

/** Why each sentence of a response is not grounded in the case; empty when it is. */
export const groundingProblems = (
  response: string,
  checklist: ChecklistItem[],
  factsText: string,
): string[] =>
  groundingFlags(response, checklist, factsText).map(
    (f) => `"${f.sentence}": ${f.why}`,
  );

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
  // the model sees only what is on file: never a list of what we lack
  const facts = c.evidences.flatMap((e) => [
    ...(e.notes
      ? [
          e.evidence_type === "ADDED_BY_THE_MERCHANT"
            ? e.notes
            : `Note: "${e.notes}"`,
        ]
      : []),
    ...(e.evidence_info?.tracking_info ?? []).map(
      (t) => `${t.carrier_name} tracking ${t.tracking_number}`,
    ),
  ]);
  const user = JSON.stringify({
    merchant: c.merchant,
    buyer: c.buyer,
    claim: words(c.reason).replace("unauthorised", "payment not recognised"),
    amount: money(c.amount_cents, c.currency),
    ...(c.purchased_at ? { purchased_on: day(c.purchased_at) } : {}),
    items: c.items.map((i) => `${i.item_quantity} × ${i.item_description}`),
    buyer_messages: c.messages
      .filter((m) => m.posted_by === "BUYER")
      .map((m) => m.content),
    facts_on_file: facts,
    our_position: positionFor(c),
  });
  const proof = [
    c.purchased_at ? day(c.purchased_at) : "",
    ...c.evidences.flatMap((e) => [
      e.notes ?? "",
      ...(e.evidence_info?.tracking_info ?? []).map(
        (t) => `tracking ${t.carrier_name} ${t.tracking_number}`,
      ),
    ]),
  ].join(" ");
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
  const stripHead = (t: string) =>
    t.trim().replace(/^Re:(?:[^.]*?\([^)]*\)\.?|[^.]*\.)\s*/i, "");
  const factsText = facts.join(" ");
  /** The grounded sentences of a model reply, judged one by one, or why too few survive. */
  const check = (
    v: unknown,
  ): { body: string; bad?: undefined } | { bad: string; body?: undefined } => {
    const t = (v as { response?: unknown } | null)?.response;
    if (typeof t !== "string" || !t.trim())
      return { bad: "the reply did not match the draft shape" };
    const dropped: string[] = [];
    const kept = sentencesOf(stripHead(t)).filter((x) => {
      const why =
        invalidReason(x, user, proof) ??
        groundingFlags(x, fb.checklist, factsText)[0]?.why;
      if (why) dropped.push(`"${x}" (${why})`);
      return !why;
    });
    if (kept.length >= 2 && positionKey(c.reason).test(kept.join(" ")))
      return { body: kept.join(" ") };
    return {
      bad: dropped.length
        ? `these sentences were not allowed: ${dropped.join("; ")}`
        : "it did not argue our position in at least two sentences",
    };
  };
  let r = await ask(user);
  let res = r.source === "llm" ? check(r.value) : undefined;
  if (r.source === "llm" && res?.bad) {
    r = await ask(
      `${user}\n\nYour previous answer was rejected because ${res.bad}. Write it again without that, using only facts_on_file and our_position.`,
    );
    res = r.source === "llm" ? check(r.value) : undefined;
  }
  if (r.source === "llm" && res?.body)
    return {
      // the computed head names the buyer in full, whatever the model opened with
      response: `${headOf(c)} ${res.body}`,
      // the computed checklist and explanation are the truth the page gates on
      checklist: fb.checklist,
      explanation: fb.explanation,
      source: "llm",
      label: added?.length ? LABEL_AI_UPDATED : LABEL_AI,
      ...(r.model ? { model: r.model } : {}),
    };
  return {
    ...fb,
    source: "fallback",
    label: LABEL_TEMPLATE,
    error: res?.bad ?? r.error ?? "AI draft unavailable",
  };
}
