import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPayPalClient, PayPalApiError } from "@jeirslab/paypal-client";
import { createMockServer, type MockServer } from "@jeirslab/paypal-mock";

describe("dispute writes with a request id", () => {
  let mock: MockServer;
  let port: number;
  before(async () => {
    mock = createMockServer({ log: false, seed: 5 });
    port = await mock.listen(0, "127.0.0.1");
  });
  after(() => mock.close());

  it("acceptClaim replays: one refund transaction, both calls 200", async () => {
    const client = createPayPalClient({
      env: "mock",
      baseUrl: `http://127.0.0.1:${port}`,
      clientId: "c",
      clientSecret: "s",
      maxRetries: 0,
    });
    const target = [...mock.state.disputes.values()].find(
      (d) => d.status === "WAITING_FOR_SELLER_RESPONSE",
    );
    assert.ok(target, "seed has a dispute waiting for the seller");
    const before = mock.state.transactions.length;
    const body = {
      note: "refund",
      refund_amount: target.dispute_amount,
    };
    const a = await client.disputes.acceptClaim(target.dispute_id, body, {
      requestId: "accept-1",
    });
    const idemBefore = mock.state.idempotency.size;
    const b = await client.disputes.acceptClaim(target.dispute_id, body, {
      requestId: "accept-1",
    });
    assert.deepEqual(b, a);
    assert.equal(mock.state.idempotency.size, idemBefore);
    assert.equal(mock.state.transactions.length, before + 1);
    assert.equal(
      mock.state.disputes.get(target.dispute_id)!.status,
      "RESOLVED",
    );
    // without a request id the resolved dispute is refused (the fallback guard)
    await assert.rejects(
      client.disputes.acceptClaim(target.dispute_id, body),
      (e: unknown) => e instanceof PayPalApiError && e.status === 422,
    );
  });
});
