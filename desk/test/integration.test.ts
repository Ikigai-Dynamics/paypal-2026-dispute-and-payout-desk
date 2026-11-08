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
            notes: "Shipped with UPS",
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
    const tn = buildChecklist(toView(row)).find(
      (c) => c.item === "Tracking number",
    );
    assert.equal(tn?.status, "present");
  });
});
