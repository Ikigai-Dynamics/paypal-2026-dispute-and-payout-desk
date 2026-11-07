import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Dispute } from "@jeirslab/paypal-client/types";
import { buildSearchText, toCents, toRow } from "../src/sync.js";
import { toPrecedent, topTermsQuery, toView } from "../src/analysis.js";

const dispute: Dispute = {
  dispute_id: "PP-D-9",
  create_time: "2026-11-01T00:00:00Z",
  update_time: "2026-11-02T00:00:00Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "120.05" },
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  links: [],
  disputed_transactions: [
    {
      seller_transaction_id: "T1",
      create_time: "2026-10-30T00:00:00Z",
      transaction_status: "COMPLETED",
      gross_amount: { currency_code: "USD", value: "120.05" },
      buyer: { name: "Ava Chen" },
      seller: { merchant_id: "M", name: "S" },
      items: [{ item_description: "Hardware kit", item_quantity: "2" }],
    },
  ],
  seller_response_due_date: "2026-11-11T00:00:00Z",
  messages: [
    {
      posted_by: "BUYER",
      time_posted: "2026-11-01T00:00:00Z",
      content: "Package never arrived",
    },
  ],
  evidences: [
    {
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: {
        tracking_info: [{ carrier_name: "FedEx", tracking_number: "123" }],
      },
      notes: "Delivered Tuesday",
    },
  ],
};

describe("search_text", () => {
  it("holds the reason in words, messages, items, evidence notes and carriers", () => {
    const t = buildSearchText(dispute);
    for (const w of [
      "merchandise or service not received",
      "Package never arrived",
      "Hardware kit",
      "Delivered Tuesday",
      "FedEx",
      "proof of fulfillment",
    ])
      assert.ok(t.includes(w), w);
  });

  it("is stored in raw by toRow, with cents parsed from the string", () => {
    const row = toRow(dispute);
    assert.equal(row.amount_cents, 12005);
    assert.equal(row.raw.search_text, buildSearchText(dispute));
    assert.equal(row.evidence_on_file, true);
    assert.equal(row.buyer, "Ava Chen");
    assert.equal(toCents("9.5"), 950);
  });
});

describe("precedents", () => {
  it("won means the outcome is seller favour", () => {
    const p = { dispute_id: "x", amount_cents: 1, snippet: "" };
    assert.equal(
      toPrecedent({ ...p, outcome: "RESOLVED_SELLER_FAVOUR" }).won,
      true,
    );
    assert.equal(
      toPrecedent({ ...p, outcome: "RESOLVED_BUYER_FAVOUR" }).won,
      false,
    );
  });

  it("top terms make a safe OR query", () => {
    const q = topTermsQuery(
      "tracking tracking delivered the package; drop table cases; --",
    );
    assert.match(q, /^[a-z]+( \| [a-z]+)*$/);
    assert.ok(q.startsWith("tracking"));
    assert.equal(topTermsQuery("a b"), "dispute");
  });

  it("view computes days left from due_at", () => {
    const v = toView(toRow(dispute), Date.parse("2026-11-06T00:00:00Z"));
    assert.equal(v.days_left, 5);
    assert.equal(v.items[0]?.item_description, "Hardware kit");
  });
});
