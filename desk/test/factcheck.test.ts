import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAdded } from "../src/sync.js";
import {
  addedSentences,
  claimsOf,
  unsupportedClaims,
} from "../src/factcheck.js";

const NO_SHIPMENT = "Purchased 2026-10-28. 1 × Sleeping bag.";
const UPS =
  "UPS tracking 1Z999AA10123456784 shows the order was delivered Oct 30.";

const FULL =
  "UPS tracking 1Z999AA10123456784 shows the sleeping bag was delivered Oct 30 to the buyer's verified shipping address.";

describe("unsupportedClaims", () => {
  it("words the reasons as capitalised sentences with a display date", () => {
    const [r] = unsupportedClaims(FULL, NO_SHIPMENT);
    assert.equal(
      r!.reason,
      "Mentions UPS tracking 1Z999AA10123456784, but no shipment is on file. Gives the date Oct 30, but no shipment or delivery on file has that date. Mentions a shipping address match, but none is on file.",
    );
    for (const s of r!.reason.split(/(?<=\.) /)) assert.match(s, /^[A-Z]/);
    assert.ok(!r!.reason.includes("oct 30"));
  });
  it("flags the invented UPS delivery", () => {
    const r = unsupportedClaims(UPS, NO_SHIPMENT);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.sentence, UPS);
    assert.match(
      r[0]!.reason,
      /UPS tracking 1Z999AA10123456784, but no shipment is on file\./,
    );
  });
  it("flags an address match only when no address note exists", () => {
    const s = "The shipping address matches the buyer's PayPal address.";
    assert.equal(unsupportedClaims(s, NO_SHIPMENT).length, 1);
    assert.equal(
      unsupportedClaims(s, `${NO_SHIPMENT} Shipping address matches PayPal.`)
        .length,
      0,
    );
  });
  it("passes a sentence quoting real tracking", () => {
    const proof = "UPS 1Z999AA10123456784 shipped Oct 28, delivered Oct 30";
    assert.deepEqual(unsupportedClaims(UPS, proof), []);
  });
  it("passes plain sentences", () => {
    assert.deepEqual(
      unsupportedClaims("The buyer ordered one sleeping bag.", NO_SHIPMENT),
      [],
    );
  });
});

describe("parseAdded", () => {
  it("takes the page's shape and keeps it canonical", () => {
    const page = {
      item: "Email log",
      evidence_type: "PROOF_OF_FULFILLMENT",
      notes: "Code sent Oct 28",
      tracking: { carrier: "UPS", number: "1Z 999" },
    };
    assert.deepEqual(parseAdded([page]), [page]);
  });
  it("maps note to notes and a missing type from the item", () => {
    const r = parseAdded([
      { item: "Delivery photo", note: "x" },
      { item: "Refund receipt", note: "x" },
      { item: "Something else", notes: "x" },
    ]);
    assert.deepEqual(
      r.map((x) => x.evidence_type),
      ["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "OTHER"],
    );
    assert.equal(r[0]!.notes, "x");
  });
  it("rejects an unknown type", () => {
    assert.throws(() =>
      parseAdded([{ item: "a", notes: "b", evidence_type: "NOPE" }]),
    );
  });
});

describe("billing address", () => {
  it("is no proof of a shipping address match", () => {
    const s = "The shipping address matches the buyer's PayPal address.";
    assert.equal(
      unsupportedClaims(s, "Two tents shipped by UPS to the billing address")
        .length,
      1,
    );
  });
});

describe("merchant-added statements", () => {
  const base =
    "We ask PayPal to review the two charges. We hold one order record. We ask PayPal to find in our favour.";
  const lie =
    "The buyer received a full refund already and signed for delivery twice.";
  it("lists every added or changed sentence and none of the draft's own", () => {
    assert.deepEqual(addedSentences(base, base), []);
    assert.deepEqual(addedSentences(base, `${base} ${lie}`), [lie]);
    assert.deepEqual(
      addedSentences(
        base,
        base.replace("one order record", "two order records"),
      ),
      ["We hold two order records."],
    );
  });
  it("asks for an attestation per sentence until it is given", () => {
    const added = addedSentences(base, `${base} ${lie}`);
    assert.deepEqual(
      claimsOf([], added, []).map((c) => [c.sentence, c.kind]),
      [[lie, "added"]],
    );
    assert.deepEqual(claimsOf([], added, [lie]), []);
  });
});
