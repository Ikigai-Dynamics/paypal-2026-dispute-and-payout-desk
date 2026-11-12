import type { CaseSummary } from "../lib/api";
import { callKind, money, pct } from "../lib/format";

/** what Parley says when a case is picked; **bold** marks the figures */
export function line(c: CaseSummary): string {
  const first = c.buyer.split(" ")[0] || "The buyer";
  const item = (c.item ?? "order").toLowerCase();
  const k = callKind(c.call);
  const chance = c.p != null ? ` You'd probably ${c.p >= 0.5 ? "win" : "lose"}, about **${pct(c.p)}%**, but` : "";
  if (k === "offer" && c.offer_cents)
    return `${first} opened a dispute over the ${item}.${chance ? `${chance} a loss costs the refund plus fees.` : ""} Offer **${money(c.offer_cents, c.currency)}** back and this is likely over.`;
  if (k === "fight")
    return `This one's worth a fight.${c.p != null ? ` I put your chance at **${pct(c.p)}%**.` : ""} Your reply is drafted for you to check.`;
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
