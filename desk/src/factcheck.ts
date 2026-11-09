import type { CaseView } from "./types.js";

export interface Unsupported {
  sentence: string;
  reason: string;
}

const CARRIER =
  /\b(UPS|USPS|FedEx|DHL|Royal Mail|Canada Post|OnTrac|Amazon Logistics)\b/i;
const TRACKING = /\b1Z[0-9A-Z]{16}\b|\b9\d{15,21}\b|\b\d{10,22}\b/g;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const MONTH_DAY = new RegExp(`\\b(${MONTHS})[a-z]*\\.? (\\d{1,2})\\b`, "gi");
const ISO = /\b\d{4}-\d{2}-\d{2}\b/g;
const SHIP_WORD = /\b(shipped|delivered|dispatched|arrived)\b/i;
// [noun in the sentence, what the proof must say]
const NOUNS: [RegExp, RegExp, string][] = [
  [
    /shipping address|address match/i,
    /shipping address|address match/i,
    "a shipping address match",
  ],
  [/billing address/i, /billing address/i, "a billing address"],
  [/\bsignature\b/i, /signature|signed/i, "a signature"],
  [
    /delivery confirmation/i,
    /delivery confirmation|confirmed delivery/i,
    "a delivery confirmation",
  ],
  [/proof of delivery/i, /proof of delivery/i, "proof of delivery"],
  [/e-?mail logs?/i, /e-?mail logs?|logs?/i, "an email log"],
  [/\bredemption\b/i, /redemption|redeemed/i, "a redemption"],
  [/\bphotos?\b/i, /\bphotos?\b/i, "photos"],
  [/\breceipt\b/i, /\breceipt\b/i, "a receipt"],
  [/refund issued/i, /refund issued/i, "a refund"],
  [/return received/i, /return received/i, "a return"],
];

const MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const show = (d: string) => {
  const [m, n] = d.split(" ");
  return `${MON[MONTHS.split("|").indexOf(m!)] ?? m} ${n}`;
};
const day = (m: RegExpMatchArray) => `${m[1]!.toLowerCase()} ${m[2]}`;

/** Sentences of `text` that mention a carrier, tracking number, ship/delivery date or evidence item that `proofText` does not. */
export function unsupportedClaims(
  text: string,
  proofText: string,
): Unsupported[] {
  const proof = proofText.toLowerCase();
  const proofCompact = proof.replace(/[\s-]/g, "");
  const proofDays = [...proofText.matchAll(MONTH_DAY)].map(day);
  const out: Unsupported[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const reasons: string[] = [];
    const carrier = CARRIER.exec(sentence)?.[1];
    const carrierBad = carrier && !proof.includes(carrier.toLowerCase());
    const number = (sentence.match(TRACKING) ?? []).find(
      (n) => !proofCompact.includes(n.toLowerCase()),
    );
    if (carrierBad || number)
      reasons.push(
        `Mentions ${[carrierBad ? carrier : "", number ? "tracking " + number : ""].filter(Boolean).join(" ")}, but no shipment is on file.`,
      );
    if (SHIP_WORD.test(sentence)) {
      const bad =
        [...sentence.matchAll(MONTH_DAY)]
          .map(day)
          .find((d) => !proofDays.includes(d)) ??
        (sentence.match(ISO) ?? []).find((d) => !proof.includes(d));
      if (bad)
        reasons.push(
          `Gives the date ${/^\d/.test(bad) ? bad : show(bad)}, but no shipment or delivery on file has that date.`,
        );
    }
    for (const [said, stem, name] of NOUNS)
      if (said.test(sentence) && !stem.test(proof))
        reasons.push(`Mentions ${name}, but none is on file.`);
    if (reasons.length) out.push({ sentence, reason: reasons.join(" ") });
  }
  return out;
}

/** Everything a sentence of the response may rest on: what is on file, the seller's own messages, the merchant's added notes, and this send's own evidence. */
export function proofText(
  view: CaseView,
  added: {
    item: string;
    notes: string;
    tracking?: { carrier: string; number: string };
  }[],
): string {
  const lines: string[] = view.items.map(
    (i) => `${i.item_quantity} ${i.item_description}`,
  );
  if (view.purchased_at) {
    const dt = new Date(view.purchased_at);
    lines.push(
      `purchased ${view.purchased_at.slice(0, 10)} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`,
    );
  }
  for (const m of view.messages) {
    if (m.posted_by === "SELLER") lines.push(m.content);
    // only the date of the buyer's message is on file for a facts sentence, not what it says
    else {
      const dt = new Date(m.time_posted);
      lines.push(`buyer message ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`);
    }
  }
  for (const e of view.evidences) {
    lines.push(e.notes ?? "");
    for (const t of e.evidence_info?.tracking_info ?? [])
      lines.push(`${t.carrier_name ?? ""} ${t.tracking_number ?? ""}`);
  }
  for (const a of added)
    lines.push(
      `${a.item}: ${a.notes}`,
      a.tracking ? `${a.tracking.carrier} ${a.tracking.number}` : "",
    );
  return lines.join("\n");
}

/** The gate before a send, and the dry run: sentences still unsupported after the vouched ones. The text goes out exactly as written. */
export function gateEvidence(
  text: string,
  proofText: string,
  vouched: string[],
) {
  const claims = unsupportedClaims(text, proofText);
  return {
    unsupported: claims.filter((c) => !vouched.includes(c.sentence)),
    held: claims.map((c) => c.sentence).filter((x) => vouched.includes(x)),
  };
}
