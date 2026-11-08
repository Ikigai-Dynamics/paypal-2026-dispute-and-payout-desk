import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unsupportedClaims } from "../src/factcheck.js";

const NO_SHIPMENT = "Purchased 2026-10-28. 1 × Sleeping bag.";
const UPS =
  "UPS tracking 1Z999AA10123456784 shows the order was delivered Oct 30.";

describe("unsupportedClaims", () => {
  it("flags the invented UPS delivery", () => {
    const r = unsupportedClaims(UPS, NO_SHIPMENT);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.sentence, UPS);
    assert.match(
      r[0]!.reason,
      /UPS tracking 1Z999AA10123456784, but no shipment is on file/,
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
