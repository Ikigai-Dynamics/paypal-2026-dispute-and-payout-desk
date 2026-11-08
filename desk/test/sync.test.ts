import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Dispute } from "@jeirslab/paypal-client/types";
import {
  buildSearchText,
  parseExtra,
  syncAll,
  toCents,
  toRow,
  ValidationError,
} from "../src/sync.js";
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

describe("evidence validation", () => {
  const ev = { item: "Tracking", evidence_type: "OTHER", notes: "n" };
  const file = {
    name: "a.png",
    content_type: "image/png",
    data_base64: "AAAA",
  };
  it("accepts a good payload and nothing", () => {
    assert.equal(parseExtra({}), undefined);
    const x = parseExtra({
      evidence: [{ ...ev, tracking: { carrier: "UPS", number: "1Z 9-9" } }],
      files: [file],
    });
    assert.equal(x?.evidence[0]?.tracking?.number, "1Z 9-9");
    assert.equal(x?.files.length, 1);
  });
  it("rejects a bad content type, too many items, bad tracking, slashes", () => {
    const no = (b: Record<string, unknown>) =>
      assert.throws(() => parseExtra(b), ValidationError);
    no({ files: [{ ...file, content_type: "text/html" }] });
    no({ evidence: Array(6).fill(ev) });
    no({ evidence: [{ ...ev, tracking: { carrier: "UPS", number: "1;2" } }] });
    no({ files: [{ ...file, name: "a/b.png" }] });
    no({ files: [{ ...file, data_base64: "" }] });
  });
});

describe("sync prunes", () => {
  it("retainOnly receives every id the listing returned", async () => {
    const kept: string[][] = [];
    const sink = {
      upsert: async () => {},
      retainOnly: async (ids: string[]) => void kept.push(ids),
    };
    const paypal = {
      disputes: {
        list: async () => ({
          items: [{ dispute_id: "A" }, { dispute_id: "B" }],
          links: [],
        }),
        get: async (id: string) => ({ ...dispute, dispute_id: id }),
      },
    };
    assert.equal(await syncAll(paypal as never, sink), 2);
    assert.deepEqual(kept, [["A", "B"]]);
  });
  it("does not prune when the listing fails", async () => {
    let pruned = false;
    const sink = {
      upsert: async () => {},
      retainOnly: async () => void (pruned = true),
    };
    const paypal = {
      disputes: {
        list: async () => ({ items: [{ dispute_id: "A" }], links: [] }),
        get: async () => {
          throw new Error("boom");
        },
      },
    };
    await assert.rejects(syncAll(paypal as never, sink));
    assert.equal(pruned, false);
  });
});
