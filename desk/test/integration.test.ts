import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPayPalClient, type PayPalClient } from "@jeirslab/paypal-client";
import { createMockServer, type MockServer } from "@jeirslab/paypal-mock";
import type { CaseRow } from "../src/types.js";
import {
  acceptClaim,
  submitEvidence,
  syncAll,
  type Sink,
} from "../src/sync.js";
import { toView } from "../src/analysis.js";
import { gateEvidence, proofText } from "../src/factcheck.js";
import { buildChecklist } from "../src/draft.js";

class MemorySink implements Sink {
  rows = new Map<string, CaseRow>();
  async upsert(r: CaseRow) {
    this.rows.set(r.dispute_id, r);
  }
  async retainOnly(ids: string[]) {
    for (const k of [...this.rows.keys()])
      if (!ids.includes(k)) this.rows.delete(k);
  }
}

describe("sync and writes against the in-process mock", () => {
  let mock: MockServer;
  let paypal: PayPalClient;
  const sink = new MemorySink();
  before(async () => {
    mock = createMockServer({ log: false, seed: 7, seedDisputes: 60 } as never);
    const port = await mock.listen(0, "127.0.0.1");
    paypal = createPayPalClient({
      env: "mock",
      baseUrl: `http://127.0.0.1:${port}`,
      clientId: "mock-client",
      clientSecret: "mock-secret",
    });
  });
  after(() => mock.close());

  it("syncs every page and builds search text", async () => {
    const n = await syncAll(paypal, sink, 20); // 60 disputes over 3 pages
    assert.equal(n, 60);
    assert.equal(sink.rows.size, 60);
    assert.ok(
      [...sink.rows.values()].every((r) => r.raw.search_text.length > 0),
    );
    const resolved = [...sink.rows.values()].filter(
      (r) => r.status === "RESOLVED",
    );
    assert.ok(new Set(resolved.map((r) => r.outcome)).size === 2);
  });

  it("provide-evidence moves a case to UNDER_REVIEW and the row is refreshed", async () => {
    const open = [...sink.rows.values()].find(
      (r) => r.status === "WAITING_FOR_SELLER_RESPONSE",
    )!;
    const row = await submitEvidence(
      paypal,
      sink,
      open.dispute_id,
      "Shipped with tracking UPS 1Z; delivered.",
    );
    assert.equal(row.status, "UNDER_REVIEW");
    assert.equal(sink.rows.get(open.dispute_id)?.status, "UNDER_REVIEW");
    assert.equal(row.due_at, null);
    assert.ok(row.raw.search_text.includes("delivered"));
  });

  it("accept-claim resolves in the buyer's favour", async () => {
    const open = [...sink.rows.values()].find(
      (r) => r.status === "WAITING_FOR_SELLER_RESPONSE",
    )!;
    const row = await acceptClaim(paypal, sink, open.dispute_id, "ok");
    assert.equal(row.status, "RESOLVED");
    assert.equal(row.outcome, "RESOLVED_BUYER_FAVOUR");
  });

  it("evidence with a tracking item and a PNG reaches the mock and fills the checklist", async () => {
    const open = [...sink.rows.values()].find(
      (r) =>
        r.status === "WAITING_FOR_SELLER_RESPONSE" &&
        r.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    )!;
    const row = await submitEvidence(
      paypal,
      sink,
      open.dispute_id,
      "Shipped.",
      {
        evidence: [
          {
            item: "Tracking",
            evidence_type: "PROOF_OF_FULFILLMENT",
            notes: "Shipped with UPS; the code was sent by email",
            tracking: { carrier: "UPS", number: "1Z 999" },
          },
        ],
        files: [
          {
            name: "label.png",
            content_type: "image/png",
            data_base64: "iVBORw0KGgo=",
          },
        ],
      },
    );
    assert.equal(row.status, "UNDER_REVIEW");
    // the first item is the tracking number, or the email log for digital goods
    const first = buildChecklist(toView(row))[0];
    assert.equal(first?.status, "present");
  });

  it("the invented-fact gate blocks the UPS sentence and passes it once vouched", async () => {
    const open = [...sink.rows.values()].find(
      (r) => r.status === "WAITING_FOR_SELLER_RESPONSE",
    )!;
    const sentence =
      "UPS tracking 1Z999AA10123456784 shows the order was delivered Oct 30.";
    const proof = "1 sleeping bag";
    const blocked = gateEvidence(`We shipped it. ${sentence}`, proof, []);
    assert.deepEqual(
      blocked.unsupported.map((u) => u.sentence),
      [sentence],
    );
    const ok = gateEvidence(`We shipped it. ${sentence}`, proof, [sentence]);
    assert.equal(ok.unsupported.length, 0);
    assert.deepEqual(ok.held, [sentence]);
    const row = await submitEvidence(
      paypal,
      sink,
      open.dispute_id,
      `We shipped it. ${sentence}`,
      {
        evidence: [
          {
            item: "Your statement",
            evidence_type: "OTHER",
            notes: `Merchant statement: ${sentence}`,
          },
        ],
        files: [],
      },
    );
    assert.equal(row.status, "UNDER_REVIEW");
  });
});

describe("dry-run fact check on the Marcus Bell sleeping bag case", () => {
  const row = {
    raw: {
      disputed_transactions: [
        {
          seller: { name: "Ikigai Outfitters" },
          create_time: "2026-10-16T07:10:16.832Z",
          items: [
            { item_description: "Ember 20F Sleeping Bag", item_quantity: "1" },
          ],
        },
      ],
      messages: [
        {
          posted_by: "BUYER",
          time_posted: "",
          content:
            "There is a problem with this payment and I need help resolving it.",
        },
        {
          posted_by: "SELLER",
          time_posted: "",
          content:
            "We are sorry to hear that. Can you send a photo of the item and the packaging?",
        },
      ],
      evidences: [],
    },
  } as unknown as CaseRow;
  const proof = proofText(toView(row), []);
  const check = (t: string) => gateEvidence(t, proof, []).unsupported;
  it("passes the seller's own request for photos", () => {
    assert.deepEqual(
      check(
        "We asked the buyer for a photo of the item and packaging and have had no reply.",
      ),
      [],
    );
  });
  it("returns the invented UPS and address sentences with a reason", () => {
    for (const t of [
      "The package was shipped via UPS tracking 1Z999AA10123456784 and delivered Oct 30.",
      "The shipping address matched the buyer's PayPal address.",
    ]) {
      const r = check(t);
      assert.equal(r.length, 1);
      assert.equal(r[0]!.sentence, t);
      assert.ok(r[0]!.reason.length > 0);
    }
  });
  it("a vouched sentence is held, not returned", () => {
    const t = "The shipping address matched the buyer's PayPal address.";
    const g = gateEvidence(t, proof, [t]);
    assert.deepEqual(g.unsupported, []);
    assert.deepEqual(g.held, [t]);
  });
});
