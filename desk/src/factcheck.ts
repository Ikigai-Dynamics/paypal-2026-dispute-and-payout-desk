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
        `mentions ${[carrierBad ? carrier : "", number ? "tracking " + number : ""].filter(Boolean).join(" ")}, but no shipment is on file`,
      );
    if (SHIP_WORD.test(sentence)) {
      const bad =
        [...sentence.matchAll(MONTH_DAY)]
          .map(day)
          .find((d) => !proofDays.includes(d)) ??
        (sentence.match(ISO) ?? []).find((d) => !proof.includes(d));
      if (bad)
        reasons.push(
          `gives the date ${bad}, but no shipment or delivery on file has it`,
        );
    }
    for (const [said, stem, name] of NOUNS)
      if (said.test(sentence) && !stem.test(proof))
        reasons.push(`mentions ${name}, but none is on file`);
    if (reasons.length) out.push({ sentence, reason: reasons.join("; ") });
  }
  return out;
}

/** The gate before a send: sentences still unsupported after the vouched ones, and the text to send with the vouched ones noted. */
export function gateEvidence(
  text: string,
  proofText: string,
  vouched: string[],
) {
  const claims = unsupportedClaims(text, proofText);
  const held = claims.map((c) => c.sentence).filter((x) => vouched.includes(x));
  return {
    unsupported: claims.filter((c) => !vouched.includes(c.sentence)),
    held,
    sentText: [
      text,
      ...held.map((x) => `Merchant confirms they hold this evidence: ${x}`),
    ].join("\n"),
  };
}
