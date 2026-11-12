import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createPayPalClient,
  PayPalApiError,
  targetFromEnv,
  type PayPalClient,
} from "@jeirslab/paypal-client";
import { createMockServer, type MockServer } from "@jeirslab/paypal-mock";

const order = (value = "180.00") => ({
  intent: "CAPTURE" as const,
  purchase_units: [{ amount: { currency_code: "USD", value } }],
});

describe("targetFromEnv", () => {
  it("defaults to mock, then sandbox when an id is set", () => {
    assert.equal(targetFromEnv({}).env, "mock");
    assert.equal(
      targetFromEnv({ PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y" }).env,
      "sandbox",
    );
    assert.equal(
      targetFromEnv({ PAYPAL_CLIENT_ID: "x", PAYPAL_BASE_URL: "http://m" }).env,
      "mock",
    );
  });
  it("names missing variables only and guards live", () => {
    assert.throws(
      () => targetFromEnv({ PAYPAL_ENV: "sandbox" }),
      /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/,
    );
    assert.throws(
      () =>
        targetFromEnv({
          PAYPAL_ENV: "live",
          PAYPAL_CLIENT_ID: "a",
          PAYPAL_CLIENT_SECRET: "b",
        }),
      /PAYPAL_ALLOW_LIVE/,
    );
  });
});

describe("client against the mock", () => {
  let mock: MockServer;
  let port: number;
  let client: PayPalClient;
  before(async () => {
    mock = createMockServer({ log: false, payoutSeconds: 0, seed: 11 });
    port = await mock.listen(0, "127.0.0.1");
    client = createPayPalClient({
      env: "mock",
      baseUrl: `http://127.0.0.1:${port}`,
      clientId: "c",
      clientSecret: "s",
      maxRetries: 0,
    });
  });
  after(() => mock.close());

  it("gets a token and refreshes after the mock restarts", async () => {
    const t = await client.getAccessToken();
    assert.match(t, /^A21AA/);
    // tokens are stateless: restart on the same port with the same seed, the old token still works
    await mock.close();
    mock = createMockServer({ log: false, payoutSeconds: 0, seed: 11 });
    await mock.listen(port, "127.0.0.1");
    assert.equal((await client.orders.create(order())).status, "CREATED");
  });

  it("401 refresh: a bad cached token is replaced once", async () => {
    const c = createPayPalClient({
      env: "mock",
      baseUrl: `http://127.0.0.1:${port}`,
      clientId: "c",
      clientSecret: "s",
      maxRetries: 0,
    });
    let first = true;
    const wrapped = createPayPalClient({
      env: "mock",
      baseUrl: `http://127.0.0.1:${port}`,
      clientId: "c",
      clientSecret: "s",
      fetch: (async (u: any, init: any) => {
        if (first && String(u).includes("/v1/oauth2/token")) {
          first = false;
          return new Response(
            JSON.stringify({ access_token: "A21AAbogus", expires_in: 100 }),
            { status: 200 },
          );
        }
        return fetch(u, init);
      }) as never,
    });
    void c;
    assert.equal((await wrapped.orders.create(order())).status, "CREATED");
  });

  it("creates, captures, and refuses a second capture", async () => {
    const o = await client.orders.create(order("10.00"));
    assert.equal(o.intent, "CAPTURE");
    const c = await client.orders.capture(o.id);
    assert.equal(c.status, "COMPLETED");
    const cap = c.purchase_units[0]!.payments!.captures[0]!;
    assert.equal(cap.seller_receivable_breakdown.paypal_fee.value, "0.84");
    await assert.rejects(
      client.orders.capture(o.id),
      (e: unknown) =>
        e instanceof PayPalApiError &&
        e.status === 422 &&
        e.issue === "ORDER_ALREADY_CAPTURED",
    );
  });

  it("replays an idempotent create", async () => {
    const a = await client.orders.create(order(), { requestId: "req-1" });
    const b = await client.orders.create(order("5.00"), { requestId: "req-1" });
    assert.equal(a.id, b.id);
  });

  it("pays out and reports per-item failure", async () => {
    const r = await client.payouts.create({
      sender_batch_header: { sender_batch_id: `batch-${Date.now()}` },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: "ok@example.com",
          amount: { value: "50.00", currency: "USD" },
        },
        {
          recipient_type: "EMAIL",
          receiver: "x@fail.example",
          amount: { value: "5.00", currency: "USD" },
        },
      ],
    });
    assert.equal(r.batch_header.batch_status, "PENDING");
    const b = await client.payouts.get(r.batch_header.payout_batch_id);
    assert.equal(b.batch_header.batch_status, "SUCCESS");
    assert.deepEqual(
      b.items.map((i) => i.transaction_status),
      ["SUCCESS", "FAILED"],
    );
    assert.equal(b.items[0]!.payout_item_fee.value, "1.00");
    await assert.rejects(
      client.payouts.create({
        sender_batch_header: {
          sender_batch_id: r.batch_header.sender_batch_header.sender_batch_id,
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: "a@b.c",
            amount: { value: "1.00", currency: "USD" },
          },
        ],
      }),
      (e: unknown) => e instanceof PayPalApiError && e.status === 400,
    );
  });

  it("makes an offer on an open dispute and carries buyer info on transactions", async () => {
    const open = await client.disputes.list({
      page_size: 50,
      dispute_state: "REQUIRED_ACTION",
    });
    const id = open.items.at(-1)!.dispute_id;
    const d = await client.disputes.get(id);
    assert.ok(d.links.some((l) => l.rel === "make_offer"));
    await assert.rejects(
      client.disputes.makeOffer(id, {
        note: "x",
        offer_amount: {
          currency_code: d.dispute_amount.currency_code,
          value: "0.00",
        },
      }),
    );
    await client.disputes.makeOffer(id, {
      note: "Partial refund",
      offer_amount: {
        currency_code: d.dispute_amount.currency_code,
        value: "1.00",
      },
    });
    const after = await client.disputes.get(id);
    assert.equal(after.status, "WAITING_FOR_BUYER_RESPONSE");
    assert.equal(after.offer?.seller_offered_amount.value, "1.00");
    const tx = await client.transactions.search({
      start_date: new Date(
        Date.parse(d.disputed_transactions[0]!.create_time) - 3600_000,
      ).toISOString(),
      end_date: new Date(
        Date.parse(d.disputed_transactions[0]!.create_time) + 3600_000,
      ).toISOString(),
      transaction_id: d.disputed_transactions[0]!.seller_transaction_id,
    });
    const p = tx.transaction_details[0]!;
    assert.ok(p.payer_info.account_status);
    assert.ok(p.shipping_info?.address.city);
  });

  it("lists and pages disputes, provides evidence, accepts a claim", async () => {
    const p1 = await client.disputes.list({ page_size: 5 });
    assert.equal(p1.items.length, 5);
    const next = p1.links.find((l) => l.rel === "next");
    assert.ok(next);
    const p2 = await client.disputes.list({
      page_size: 5,
      next_page_token: new URL(next.href).searchParams.get("next_page_token")!,
    });
    assert.equal(p2.items.length, 5);
    assert.notEqual(p1.items[0]!.dispute_id, p2.items[0]!.dispute_id);

    const waiting = await client.disputes.list({
      page_size: 50,
      dispute_state: "REQUIRED_ACTION",
    });
    assert.ok(waiting.items.length >= 2);
    const [a, b] = waiting.items;
    const d = await client.disputes.get(a!.dispute_id);
    assert.ok(d.seller_response_due_date);
    const ev = await client.disputes.provideEvidence(d.dispute_id, {
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: {
            tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999" }],
          },
        },
      ],
      files: [
        {
          name: "proof.txt",
          contentType: "text/plain",
          data: new TextEncoder().encode("hello"),
        },
      ],
    });
    assert.equal(ev.links[0]!.rel, "self");
    assert.equal(
      (await client.disputes.get(d.dispute_id)).status,
      "UNDER_REVIEW",
    );
    await assert.rejects(
      client.disputes.provideEvidence(d.dispute_id, {
        evidences: [{ evidence_type: "OTHER" }],
      }),
      (e: unknown) => e instanceof PayPalApiError && e.status === 422,
    );

    await client.disputes.acceptClaim(b!.dispute_id, { note: "refund" });
    const after = await client.disputes.get(b!.dispute_id);
    assert.equal(after.status, "RESOLVED");
    assert.equal(after.dispute_outcome?.outcome_code, "RESOLVED_BUYER_FAVOUR");
  });

  it("searches transactions with paging and a 31-day guard", async () => {
    const end = new Date("2026-11-06T00:00:00Z");
    const start = new Date(end.getTime() - 30 * 86_400_000);
    const p1 = await client.transactions.search({
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      page_size: 20,
    });
    assert.ok(p1.total_items > 20);
    assert.equal(p1.transaction_details.length, 20);
    const p2 = await client.transactions.search({
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      page_size: 20,
      page: 2,
    });
    assert.notEqual(
      p1.transaction_details[0]!.transaction_info.transaction_id,
      p2.transaction_details[0]!.transaction_info.transaction_id,
    );
    await assert.rejects(
      client.transactions.search({
        start_date: new Date(end.getTime() - 40 * 86_400_000).toISOString(),
        end_date: end.toISOString(),
      }),
      (e: unknown) => e instanceof PayPalApiError && e.status === 400,
    );
  });
});
