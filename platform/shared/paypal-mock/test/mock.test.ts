import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createMockServer,
  MockState,
  loadConfig,
  type MockServer,
} from "@jeirslab/paypal-mock";

describe("mock determinism", () => {
  it("serializes identically for the same seed", () => {
    const cfg = { ...loadConfig({}), seed: 7, log: false };
    const a = new MockState({ ...cfg });
    const b = new MockState({ ...cfg });
    assert.equal(a.serialize(), b.serialize());
    const c = new MockState({ ...cfg, seed: 8 });
    assert.notEqual(a.serialize(), c.serialize());
  });
});

describe("mock http", () => {
  let mock: MockServer;
  let url: string;
  before(async () => {
    mock = createMockServer({ log: false, payoutSeconds: 0 });
    url = `http://127.0.0.1:${await mock.listen(0, "127.0.0.1")}`;
  });
  after(() => mock.close());

  const basic = `Basic ${Buffer.from("a:b").toString("base64")}`;
  const token = async () => {
    const r = await fetch(`${url}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: basic,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    return ((await r.json()) as { access_token: string }).access_token;
  };

  it("rejects missing credentials and missing bearer", async () => {
    const r = await fetch(`${url}/v1/oauth2/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
    });
    assert.equal(r.status, 401);
    const r2 = await fetch(`${url}/v1/customer/disputes`);
    assert.equal(r2.status, 401);
    assert.equal(
      ((await r2.json()) as { error: string }).error,
      "invalid_token",
    );
  });

  it("honours PayPal-Mock-Response and failure injection", async () => {
    const t = await token();
    const r = await fetch(`${url}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t}`,
        "content-type": "application/json",
        "paypal-mock-response": JSON.stringify({
          mock_application_codes: "INSTRUMENT_DECLINED",
        }),
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }],
      }),
    });
    assert.equal(r.status, 422);
    assert.equal(
      ((await r.json()) as { details: { issue: string }[] }).details[0]?.issue,
      "INSTRUMENT_DECLINED",
    );

    const failing = createMockServer({ log: false, failureEvery: 2 });
    const u = `http://127.0.0.1:${await failing.listen(0, "127.0.0.1")}`;
    const t2 = (await (
      await fetch(`${u}/v1/oauth2/token`, {
        method: "POST",
        headers: { authorization: basic },
        body: "grant_type=client_credentials",
      })
    ).json()) as { access_token: string };
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push(
        (
          await fetch(`${u}/v1/customer/disputes`, {
            headers: { authorization: `Bearer ${t2.access_token}` },
          })
        ).status,
      );
    assert.deepEqual(codes, [200, 500, 200, 500]);
    await failing.close();
  });

  it("rounds the capture fee half-even", async () => {
    const t = await token();
    const h = {
      authorization: `Bearer ${t}`,
      "content-type": "application/json",
    };
    const o = (await (
      await fetch(`${url}/v2/checkout/orders`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            { amount: { currency_code: "USD", value: "100.00" } },
          ],
        }),
      })
    ).json()) as { id: string };
    const c = (await (
      await fetch(`${url}/v2/checkout/orders/${o.id}/capture`, {
        method: "POST",
        headers: h,
        body: "{}",
      })
    ).json()) as any;
    assert.equal(
      c.purchase_units[0].payments.captures[0].seller_receivable_breakdown
        .paypal_fee.value,
      "3.98",
    );
  });
});

describe("authorizations", () => {
  let mock: MockServer;
  let url: string;
  let h: Record<string, string>;
  before(async () => {
    mock = createMockServer({ log: false });
    url = `http://127.0.0.1:${await mock.listen(0, "127.0.0.1")}`;
    const r = await fetch(`${url}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("a:b").toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    const t = ((await r.json()) as { access_token: string }).access_token;
    h = { authorization: `Bearer ${t}`, "content-type": "application/json" };
  });
  after(() => mock.close());

  const post = (path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const authorize = async (value: string): Promise<string> => {
    const o = (await (
      await post("/v2/checkout/orders", {
        intent: "AUTHORIZE",
        purchase_units: [{ amount: { currency_code: "USD", value } }],
      })
    ).json()) as { id: string };
    const r = await post(`/v2/checkout/orders/${o.id}/authorize`);
    assert.equal(r.status, 201);
    const body = (await r.json()) as any;
    assert.equal(body.status, "COMPLETED");
    const auth = body.purchase_units[0].payments.authorizations[0];
    assert.equal(auth.status, "CREATED");
    assert.equal(auth.amount.value, value);
    return auth.id as string;
  };
  const status = async (id: string) =>
    (
      (await (
        await fetch(`${url}/v2/payments/authorizations/${id}`, { headers: h })
      ).json()) as any
    ).status;
  const issue = async (r: Response) =>
    ((await r.json()) as { details: { issue: string }[] }).details[0]?.issue;

  it("captures in parts under the cap", async () => {
    const id = await authorize("150.00");
    const c1 = await post(`/v2/payments/authorizations/${id}/capture`, {
      amount: { currency_code: "USD", value: "59.00" },
    });
    assert.equal(c1.status, 201);
    assert.equal(((await c1.json()) as any).final_capture, false);
    assert.equal(await status(id), "PARTIALLY_CAPTURED");
    const c2 = await post(`/v2/payments/authorizations/${id}/capture`, {
      amount: { currency_code: "USD", value: "39.00" },
      final_capture: true,
    });
    assert.equal(c2.status, 201);
    assert.equal(((await c2.json()) as any).amount.value, "39.00");
    assert.equal(await status(id), "CAPTURED");
    assert.equal(
      await issue(await post(`/v2/payments/authorizations/${id}/void`)),
      "PREVIOUSLY_CAPTURED",
    );
  });

  it("refuses a capture over the cap", async () => {
    const id = await authorize("50.00");
    const r = await post(`/v2/payments/authorizations/${id}/capture`, {
      amount: { currency_code: "USD", value: "100.00" },
    });
    assert.equal(r.status, 422);
    assert.equal(await issue(r), "MAX_CAPTURE_AMOUNT_EXCEEDED");
  });

  it("voids a fresh authorization", async () => {
    const id = await authorize("20.00");
    const r = await post(`/v2/payments/authorizations/${id}/void`);
    assert.equal(r.status, 204);
    assert.equal(await r.text(), "");
    assert.equal(await status(id), "VOIDED");
  });
});

describe("richer synthetic disputes", () => {
  const cfg = {
    ...loadConfig({ MOCK_SEED_DISPUTES: "120" }),
    seed: 7,
    log: false,
  };

  it("mixes resolved outcomes and carries evidence, items and varied messages", () => {
    const s = new MockState({ ...cfg });
    const all = [...s.disputes.values()];
    const resolved = all.filter((d) => d.status === "RESOLVED");
    const outcomes = new Set(resolved.map((d) => d.outcome));
    assert.ok(outcomes.has("RESOLVED_SELLER_FAVOUR"));
    assert.ok(outcomes.has("RESOLVED_BUYER_FAVOUR"));
    for (const d of resolved.filter(
      (x) => x.outcome === "RESOLVED_BUYER_FAVOUR",
    ))
      assert.ok(d.dispute_outcome?.amount_refunded);
    const withTracking = all.filter((d) =>
      d.evidences.some(
        (e) =>
          e.evidence_type === "PROOF_OF_FULFILLMENT" &&
          (e.evidence_info?.tracking_info?.length ?? 0) > 0,
      ),
    );
    assert.ok(withTracking.length > 0);
    assert.ok(all.every((d) => d.disputed_transactions[0]!.items?.length));
    assert.ok(new Set(all.map((d) => d.messages[0]!.content)).size > 10);
  });

  it("is deterministic for a seed", () => {
    assert.equal(
      new MockState({ ...cfg }).serialize(),
      new MockState({ ...cfg }).serialize(),
    );
  });

  it("MOCK_NOW=now anchors at startup", () => {
    const before = Date.now();
    const c = loadConfig({ MOCK_NOW: "now" });
    assert.ok(c.now >= before && c.now <= Date.now());
    assert.equal(loadConfig({}).now, Date.parse("2026-11-06T00:00:00Z"));
  });

  it("reseed re-anchors a wall-clock now, keeps a fixed one", () => {
    const live = new MockState({
      ...loadConfig({ MOCK_NOW: "now" }),
      log: false,
    });
    live.config.now = 0;
    live.reseed();
    assert.ok(live.config.now > 0);
    const fixed = new MockState({ ...loadConfig({}), log: false });
    fixed.reseed();
    assert.equal(fixed.config.now, Date.parse("2026-11-06T00:00:00Z"));
  });
});

describe("POST /mock/disputes scenario helper", () => {
  it("creates an exact case", async () => {
    const mock = createMockServer({ log: false });
    const u = `http://127.0.0.1:${await mock.listen(0, "127.0.0.1")}`;
    const r = await fetch(`${u}/mock/disputes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dispute_id: "PP-D-X1",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        amount: "120.00",
        stage: "CHARGEBACK",
        due_in_days: 5,
        buyer_name: "Test Buyer",
        messages: ["Where is my parcel?"],
        items: [{ item_description: "Widget", item_quantity: 2 }],
        evidences: [
          {
            evidence_type: "PROOF_OF_FULFILLMENT",
            evidence_info: {
              tracking_info: [
                { carrier_name: "UPS", tracking_number: "1Z999" },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(r.status, 201);
    const d = (await r.json()) as any;
    assert.equal(d.dispute_id, "PP-D-X1");
    assert.equal(d.dispute_life_cycle_stage, "CHARGEBACK");
    assert.equal(d.disputed_transactions[0].buyer.name, "Test Buyer");
    assert.equal(d.disputed_transactions[0].items[0].item_quantity, "2");
    assert.equal(d.evidences.length, 1);
    const due = Date.parse(d.seller_response_due_date) - Date.now();
    assert.ok(Math.abs(due - 5 * 86_400_000) < 60_000);
    await mock.close();
  });
});

describe("demo dataset", () => {
  // npm test runs in the workspace dir, shared/paypal-mock
  const seedFile = resolve("../datasets/demo-merchant.json");
  it("loads in place of the generator, with relative deadlines", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    const cfg = { ...loadConfig({}), seedFile, now, log: false };
    const s = new MockState(cfg);
    assert.equal(s.disputes.size, 60);
    assert.ok(s.disputes.has("PP-D-GIFTCARD-0001"));
    for (const d of s.disputes.values()) {
      if (!d.seller_response_due_date) continue;
      const days = (Date.parse(d.seller_response_due_date) - now) / 86_400_000;
      assert.ok(days > 0 && days <= 21, `${d.dispute_id} due in ${days} days`);
    }
    assert.equal(s.dataset?.merchant["name"], "Ikigai Outfitters");
    s.reseed(3); // an explicit seed falls back to the generator
    assert.equal(s.dataset, null);
  });
});
