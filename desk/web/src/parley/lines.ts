import type { CaseSummary } from "../lib/api";
import { callKind, isWaiting, money, pct } from "../lib/format";

/** what Parley says when a case is picked; **bold** marks the figures. Uses the card's own numbers, never restates its reasoning. */
export function line(c: CaseSummary, aiDraft = false): string {
  const first = c.buyer.split(" ")[0] || "The buyer";
  const item = c.item ?? "order";
  if (isWaiting(c))
    return "This one's with PayPal now. Nothing to do until they decide.";
  const k = callKind(c.call);
  const chance =
    c.p != null ? `I put your chance of winning at **${pct(c.p)}%**.` : "";
  if (k === "offer" && c.offer_cents)
    return `${chance ? chance + " " : ""}Offer **${money(c.offer_cents, c.currency)}** back and this is likely over.`;
  if (k === "fight") {
    const m = c.margin_cents;
    const more =
      m != null && m > 0
        ? ` Fighting beats refunding by about **${money(Math.round(m / 100) * 100, c.currency, true)}**.`
        : "";
    return (
      `${chance}${more}${aiDraft ? " Your reply is drafted for you to check." : ""}` ||
      "This one's worth a fight."
    );
  }
  if (k === "accept")
    return `Honestly? Let this one go. Fighting costs more than the **${money(c.amount_cents, c.currency)}** refund on average.`;
  return `Looking at ${first}'s dispute over the ${item}. Give me a moment.`;
}

export const POKES = [
  "Hoo! That tickles.",
  "I'm a professional, you know. The bow tie says so.",
  "Careful. I bruise like a peach.",
  "I've read every dispute you've ever had. Twice.",
];
