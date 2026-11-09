import type { Llm } from "@jeirslab/llm-client";
import { DEFAULT_HANDLING_CENTS } from "./decide-client.js";
import { proofText, unsupportedClaims } from "./factcheck.js";
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
export const LABEL_TEMPLATE = "Draft (AI unavailable)";
export const LABEL_AI_UPDATED = "AI draft, updated with your evidence";
export const LABEL_GROUNDED = (added: boolean) =>
  added ? "Drafted from your evidence" : "Drafted from the case facts";

export const SYSTEM_PROMPT =
  "You write the merchant's written response to PayPal's dispute reviewer. It is not a letter to the buyer. " +
  "Write as the merchant named in the input, using 'we'. No salutation and no 'Dear ...'. Plain, factual prose; no headings. " +
  "Write 3 to 5 sentences in this order: our position; the order and every piece of evidence on file in prose, then what the buyer said; the buyer pattern when facts_on_file has one; the last sentence is one request to PayPal. Do not state the dispute reason as a label. " +
  "Mention every evidence item in facts_on_file by name (tracking, photos, email log, order record, prior orders and so on). " +
  "Never state a claim that is not in facts_on_file or our_position: no number, carrier, date, order id or document that is not there. " +
  "Never use the words shipped, delivered, enclosed, attached or 'our records' unless facts_on_file says so. " +
  "Never say any evidence is missing or still needed, and never promise to send anything later. " +
  "Never agree with the buyer or concede the claim, and never apologise. " +
  "Never say the buyer acknowledged, admitted or agreed to anything unless facts_on_file says so. " +
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

/** What we ask PayPal to check when nothing on file backs the claim of the reason. */
const requestFor = (reason: string): string => {
  switch (reason) {
    case "DUPLICATE_TRANSACTION":
      return "We ask PayPal to review the two charges against the one order we have on file.";
    case "UNAUTHORISED":
      return "We ask PayPal to review whether this payment was authorised.";
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return "We ask PayPal to check whether the item matched its listing.";
    case "CREDIT_NOT_PROCESSED":
      return "We ask PayPal to check whether this order and any return were handled correctly.";
    case "PAYMENT_BY_OTHER_MEANS":
      return "We ask PayPal to confirm that this order was paid only once, through PayPal.";
    default:
      return "We ask PayPal to review whether the order was fulfilled as placed.";
  }
};

// the checklist items whose presence backs the assertive sentence of a reason
const BACKING = (c: CaseView): string[] => {
  switch (c.reason) {
    case "DUPLICATE_TRANSACTION":
      return ["Proof the two charges are separate orders"];
    case "UNAUTHORISED":
      return [
        "Prior orders from this buyer",
        "Shipping address matches the buyer",
      ];
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return ["Listing description"];
    case "CREDIT_NOT_PROCESSED":
      return ["Return received record"];
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      return c.items.some((i) => DIGITAL.test(i.item_description))
        ? ["Proof the code was sent (email log)"]
        : ["Tracking number"];
    default:
      return ["Proof of fulfilment or service"];
  }
};

/** Our position: the reason's claim only when a checklist item backing it is on file, else a request to PayPal. */
export function positionFor(c: CaseView): string {
  if (c.reason === "PAYMENT_BY_OTHER_MEANS")
    return notesMatch(
      c,
      /one payment|single payment|paid (once|through paypal)/i,
    )
      ? "Our records show one payment for this order, through PayPal."
      : requestFor(c.reason);
  const backing = BACKING(c);
  return buildChecklist(c).some(
    (i) => i.status === "present" && backing.includes(i.item),
  )
    ? positionOf(c.reason)
    : requestFor(c.reason);
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
/** An evidence note that explicitly says the shipping address matches; a billing address is not a match. */
const ADDRESS_MATCH =
  /shipping address (matches|matched|is the same as|same as)|address (matches|matched)|address match/i;

/** Two distinct order records, or a merchant note that says so; the checklist item's own name is not evidence. */
const twoOrders = (c: CaseView): boolean => {
  const notes = c.evidences.map((e) =>
    (e.notes ?? "").replace(
      /^Proof the two charges are separate orders:\s*/,
      "",
    ),
  );
  const records = new Set(notes.filter((n) => /^Order record:/i.test(n)));
  return (
    records.size >= 2 ||
    notes.some((n) =>
      /(two|2) separate orders|separate orders|different orders/i.test(n),
    )
  );
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
  const sellerMsg = c.messages.findLast((m) => m.posted_by === "SELLER");
  const sellerDay = sellerMsg
    ? new Date(sellerMsg.time_posted).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "";
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
          false,
          notesMatch(c, ADDRESS_MATCH),
          "An evidence note refers to the address match.",
          "No address match is on file.",
        ),
        item(
          "Prior orders from this buyer",
          true,
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
          twoOrders(c),
          "Two order records, or a note saying so, show the two charges are separate orders.",
          "Nothing on file shows the two charges are separate orders.",
          !!c.purchased_at && {
            label: `Attach the order record: ${day(c.purchased_at)}`,
            note: `Order record: ${order || "the order"}, ${money(c.amount_cents, c.currency)}, placed ${day(c.purchased_at)}.`,
          },
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
          `Your message to the buyer on ${sellerDay} is on the thread and is sent with your response.`,
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

/** The order, every evidence item on the case and the buyer's latest message: the facts sentence, nothing else. */
export function factsSentence(c: CaseView): string {
  const order = c.items
    .map((i) => `${i.item_quantity} × ${i.item_description}`)
    .join(", ");
  const clauses = [
    `the order${c.purchased_at ? ` of ${day(c.purchased_at)}` : ""}${order ? ` for ${order}` : ""}, ${money(c.amount_cents, c.currency)}`,
    ...c.evidences.flatMap((e) => [
      ...(e.notes ? [e.notes.trim().replace(/[.\s]+$/, "")] : []),
      ...(e.evidence_info?.tracking_info ?? []).map(
        (t) => `${t.carrier_name} tracking number ${t.tracking_number}`,
      ),
    ]),
  ];
  const msg = c.messages.findLast((m) => m.posted_by === "BUYER");
  if (msg) clauses.push(`${c.buyer}'s message of ${day(msg.time_posted)}`);
  return `On file: ${clauses.join("; ")}.`;
}

/** The buyer pattern, only when the buyer has 3 or more disputes open with us at once. */
export const patternSentence = (c: CaseView): string | undefined =>
  (c.buyer_open_disputes ?? 0) >= 3
    ? `${c.buyer} has ${c.buyer_open_disputes} open disputes with us at the same time; we ask PayPal to take this pattern into account.`
    : undefined;

const CLOSING = "We ask PayPal to find in our favour.";
const compose = (c: CaseView, position: string, support?: string) =>
  [position, factsSentence(c), support, patternSentence(c), CLOSING]
    .filter(Boolean)
    .join(" ");

/** Deterministic template per reason: position, the facts on file, the buyer pattern, the closing request. */
export function fallbackDraft(
  c: CaseView,
  decision: Decision | null,
  handlingCents?: number,
): Omit<Draft, "source" | "label"> {
  return {
    response: compose(c, positionFor(c)),
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
/** Sentences that assert what only the buyer's messages or an evidence note could back; the reason when `x` is one. */
export function unbackedClaim(
  x: string,
  proof: string,
  buyerText: string,
): string | null {
  const adm =
    /\b(buyer|customer|cardholder) (?:has |have )?(acknowledged|admitted|confirmed|agreed|stated|said)\b/i.exec(
      x,
    );
  if (adm && !new RegExp(adm[2]!.slice(0, 5), "i").test(buyerText))
    return "it states something the buyer never said";
  if (
    /\bour system (shows?|records?)|recorded in our system|\bas recorded\b|\bno record of any\b|\bno reported issues\b|\bcompleted successfully\b/i.test(
      x,
    ) &&
    !/record|log/i.test(proof)
  )
    return "it cites our system, which no evidence note backs";
  const separate = /separate|two orders|different order/i.test(proof);
  if (
    !separate &&
    /\bauthori[sz]ed by the same cardholder|\bsame customer\b|\bwithin (a few )?minutes\b|\b(two|2|both) (distinct |separate |different )?(purchases|orders|transactions)\b|\bseparate (purchases|orders)\b/i.test(
      x,
    )
  )
    return "it says the charges were separate or related, which no evidence note says";
  if (/\bshipments?\b/i.test(x) && !separate && !/ship|tracking/i.test(proof))
    return "it mentions shipments, which no evidence note does";
  if (
    /only (placed|made) one order/i.test(buyerText) &&
    !separate &&
    /\b(two|2) (distinct |separate )?(purchases|orders)\b/i.test(x)
  )
    return "it contradicts the buyer's message";
  if (
    /\b(buyer|customer|cardholder)\b[^.]{0,40}\b(has not|did not|never|failed to|hasn't|didn't|has provided|provided|did provide|responded)\b/i.test(
      x,
    )
  )
    return "it says what the buyer did or did not do, which is not on file";
  if (
    /\b(system|systems|platform|checkout)\b[^.]{0,30}\b(shows?|indicates?|confirms?|verified|verifies|processed|transmitted)\b|\bverified\b|\bno (prior|other|additional|further) (disputes?|refunds?|returns?|complaints?|fraud)/i.test(
      x,
    ) &&
    !/record|log|system/i.test(proof)
  )
    return "it cites a system check or history that no evidence note backs";
  return null;
}

// words a supporting sentence may use whatever the case: they assert nothing about what happened
const COMMON = new Set(
  (
    "the a an and or but not no of to in on at by for with from as is are was were be been it its this that these those we our us ask paypal please " +
    "find favour favor review reviewer facts fact claim dispute disputed order orders charge charges payment payments transaction transactions purchase purchases " +
    "buyer buyer's account amount item items placed made through also which who has have had will would should can could may than then there their they them " +
    "so such any all each both only other same one two three about over under into out up after before during while when where what whether because since " +
    "respectfully therefore thus according per based complaint position response"
  ).split(" "),
);
/** Content words of a sentence that nothing the model was given contains; numbers count double. */
export function unsupportedWords(x: string, source: string): string[] {
  const stem = (w: string) =>
    w
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "")
      .slice(0, 5);
  const known = new Set(
    (source.match(/[A-Za-z0-9]+(?:[.'][A-Za-z0-9]+)*/g) ?? []).map(stem),
  );
  return (x.match(/[A-Za-z0-9]+(?:[.'][A-Za-z0-9]+)*/g) ?? []).flatMap((w) => {
    const t = stem(w);
    if (
      t.length < 3 ||
      COMMON.has(w.toLowerCase().replace(/'s$/, "")) ||
      known.has(t)
    )
      return [];
    return /\d/.test(t) ? [w, w] : [w];
  });
}

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

// words that name an evidence item; a draft must use each one that is on file
const NOTE_NOUNS: RegExp[] = [
  /photos?\b/i,
  /e-?mail logs?/i,
  /prior orders?|order history|other orders?/i,
  /order record/i,
  /return policy/i,
  /listing/i,
  /address/i,
  /refund/i,
  /return/i,
  /redeem|redemption/i,
];
/** One regex per evidence item on file: the key noun the draft must contain. */
export const evidenceNouns = (c: CaseView): RegExp[] =>
  c.evidences.flatMap((e) => [
    ...((e.evidence_info?.tracking_info ?? []).length ? [/tracking/i] : []),
    ...(e.notes
      ? NOTE_NOUNS.filter((re) => re.test(e.notes!)).slice(0, 1)
      : []),
  ]);

// sentences that assert what only a backing checklist item can support
const POSITION_CLAIM =
  /separate orders|(two|2) (distinct )?orders|\b(buyer|customer) authori[sz]ed|\bwas fulfilled\b|\bmatched (its|the) listing\b|handled (this|the) order/i;
/** The position claim a reason's own backing evidence supports. */
const OWN_CLAIM = (reason: string): RegExp =>
  reason === "DUPLICATE_TRANSACTION"
    ? /separate orders|(two|2) (distinct )?orders/i
    : reason === "UNAUTHORISED"
      ? /authori[sz]ed/i
      : reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
        ? /matched/i
        : reason === "CREDIT_NOT_PROCESSED"
          ? /handled/i
          : /fulfilled/i;

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
  const position = positionFor(c);
  const backed = position === positionOf(c.reason);
  const msg = c.messages.findLast((m) => m.posted_by === "BUYER");
  const order = c.items.map(
    (i) => `${i.item_quantity} × ${i.item_description}`,
  );
  // the model sees only what is on file: never a list of what we lack
  const facts = [
    `Dispute reason: ${words(c.reason).replace("unauthorised", "payment not recognised")}`,
    `Order${c.purchased_at ? ` placed ${day(c.purchased_at)}` : ""}: ${order.join(", ")}, ${money(c.amount_cents, c.currency)}`,
    ...c.evidences.flatMap((e) => [
      ...(e.notes ? [`Evidence on file: ${e.notes}`] : []),
      ...(e.evidence_info?.tracking_info ?? []).map(
        (t) =>
          `Evidence on file: ${t.carrier_name} tracking number ${t.tracking_number}`,
      ),
    ]),
    ...(msg
      ? [`${c.buyer}'s message of ${day(msg.time_posted)}: "${msg.content}"`]
      : []),
    ...(patternSentence(c)
      ? [
          `${c.buyer} has ${c.buyer_open_disputes} open disputes with us at the same time`,
        ]
      : []),
  ];
  const user = JSON.stringify({
    merchant: c.merchant,
    buyer: c.buyer,
    position: "fight",
    our_position: position,
    facts_on_file: facts,
    task: "Write the response in 3 to 5 sentences, mentioning every evidence item in facts_on_file.",
  });
  const proof = [
    c.purchased_at ? day(c.purchased_at) : "",
    msg ? day(msg.time_posted) : "",
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
  const buyerText = c.messages
    .filter((m) => m.posted_by === "BUYER")
    .map((m) => m.content)
    .join(" ");
  /** The grounded sentences of a model reply, judged one by one, or why the reply cannot be used. */
  const check = (
    v: unknown,
  ): { body: string; bad?: undefined } | { bad: string; body?: undefined } => {
    const t = (v as { response?: unknown } | null)?.response;
    if (typeof t !== "string" || !t.trim())
      return { bad: "the reply did not match the draft shape" };
    const dropped: string[] = [];
    const kept = sentencesOf(stripHead(t)).filter((x) => {
      const why =
        (POSITION_CLAIM.test(x) &&
        !/^We ask PayPal to (review|check|confirm)/i.test(x) &&
        !(backed && OWN_CLAIM(c.reason).test(x))
          ? "it states a position that no evidence on file backs"
          : undefined) ??
        invalidReason(x, user, proof) ??
        unbackedClaim(x, proof, buyerText) ??
        (unsupportedWords(x, user).length >= 3
          ? `it says things the case does not (${unsupportedWords(x, user).slice(0, 3).join(", ")})`
          : undefined) ??
        groundingFlags(x, fb.checklist, factsText)[0]?.why ??
        // the same test the send gate applies, so a draft never trips it
        unsupportedClaims(x, `${proofText(c, [])}\n${factsText}`)[0]?.reason;
      if (why) dropped.push(`"${x}" (${why})`);
      return !why;
    });
    const why = dropped.length
      ? `these sentences were not allowed: ${dropped.join("; ")}`
      : "";
    if (!/\bask PayPal\b/i.test(kept.at(-1) ?? "") && kept.length < 5)
      kept.push(CLOSING);
    if (kept.length < 3 || kept.length > 5)
      return {
        bad: `${why ? `${why}; ` : ""}it came to ${kept.length} usable sentences, not 3 to 5`,
      };
    const body = kept.join(" ");
    const gone = evidenceNouns(c).filter((re) => !re.test(body));
    if (gone.length)
      return {
        bad: `${why ? `${why}; ` : ""}it did not mention every evidence item on file (${gone.map((re) => re.source).join(", ")})`,
      };
    return { body };
  };
  let r = await ask(user);
  let res = r.source === "llm" ? check(r.value) : undefined;
  if (r.source === "llm" && res?.bad) {
    r = await ask(
      `${user}\n\nYour previous answer was rejected because ${res.bad}. Write it again without that, in 3 to 5 sentences, using only facts_on_file and our_position.`,
    );
    res = r.source === "llm" ? check(r.value) : undefined;
  }
  if (r.source === "llm" && res?.body)
    return {
      response: res.body,
      // the computed checklist and explanation are the truth the page gates on
      checklist: fb.checklist,
      explanation: fb.explanation,
      source: "llm",
      label: added?.length ? LABEL_AI_UPDATED : LABEL_AI,
      ...(r.model ? { model: r.model } : {}),
    };
  const down = r.source !== "llm";
  return {
    ...fb,
    source: "fallback",
    fallback_reason: down ? "ai_down" : "grounding",
    label: down ? LABEL_TEMPLATE : LABEL_GROUNDED(!!added?.length),
    error: res?.bad ?? r.error ?? "AI draft unavailable",
  };
}
