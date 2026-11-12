import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createPayPalClient, type PayPalClient } from "@jeirslab/paypal-client";
import { createMockServer, type MockServer } from "@jeirslab/paypal-mock";
import {
  checkOffer,
  maskEmail,
  paypalRoutes,
  webhookDispute,
} from "../src/paypal-routes.js";
import { init as initActivity } from "../src/activity.js";
import { syncAll } from "../src/sync.js";
import type { CaseRow } from "../src/types.js";

describe("offer validation", () => {
  const ok = { confirm: true, amount_cents: 1000 };
  it("needs confirm", () => {
    assert.deepEqual(checkOffer({ amount_cents: 1000 }, 5000), {
      error: ["confirmation_required", "send confirm: true to write to PayPal"],
    });
  });
  it("refuses an amount at or above the case amount, zero, and non-integers", () => {
    for (const a of [5000, 6000, 0, -1, 10.5, "1000", null])
      assert.ok(
        "error" in checkOffer({ confirm: true, amount_cents: a }, 5000),
        String(a),
      );
  });
  it("accepts a whole smaller amount and defaults the type and note", () => {
    const r = checkOffer(ok, 5000);
    assert.ok(!("error" in r));
    if (!("error" in r)) assert.equal(r.type, "REFUND");
    assert.ok("error" in checkOffer({ ...ok, offer_type: "GIFT" }, 5000));
  });
});

describe("email mask", () => {
  it("keeps the first letter and the domain only", () => {
    assert.equal(maskEmail("ava.chen@example.com"), "a•••@example.com");
    assert.equal(maskEmail(undefined), null);
    assert.equal(maskEmail("nodomain"), null);
  });
});

describe("webhook routing", () => {
  const ev = (event_type: string, dispute_id?: string) => ({
    event_type,
    resource: { dispute_id },
  });
  it("syncs dispute events and ignores the rest", () => {
    for (const t of ["CREATED", "UPDATED", "RESOLVED"])
      assert.equal(
        webhookDispute(ev(`CUSTOMER.DISPUTE.${t}`, "PP-D-1")),
        "PP-D-1",
      );
    assert.equal(
      webhookDispute(ev("PAYMENT.CAPTURE.COMPLETED", "PP-D-1")),
      null,
    );
    assert.equal(webhookDispute(ev("CUSTOMER.DISPUTE.UPDATED")), null);
    assert.equal(webhookDispute(null), null);
  });
});

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail: string,
  ) {
    super(detail);
  }
}

describe("routes against the in-process mock", () => {
  let mock: MockServer;
  let paypal: PayPalClient;
  const rows = new Map<string, CaseRow>();
  const store = {
    upsert: async (r: CaseRow) => void rows.set(r.dispute_id, r),
    get: async (id: string) => rows.get(id),
    byBuyer: async (b: string, ex: string) =>
      [...rows.values()].filter((r) => r.buyer === b && r.dispute_id !== ex),
    retainOnly: async () => undefined,
  };
  const deps = () => ({
    store: store as never,
    paypal,
    HttpError,
    readJson: async (req: IncomingMessage) => {
      let t = "";
      for await (const c of req) t += c;
      return t ? JSON.parse(t) : {};
    },
    loadRow: async (id: string) => {
      const r = rows.get(id);
      if (!r) throw new HttpError(404, "not_found", id);
      return r;
    },
  });
  const call = (method: string, path: string, body?: unknown) => {
    const req = Object.assign(
      Readable.from(
        body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
      ),
      { method, headers: {} },
    ) as unknown as IncomingMessage;
    return paypalRoutes(req, new URL(path, "http://x"), deps());
  };
  before(async () => {
    mock = createMockServer({ log: false, seed: 7, seedDisputes: 40 } as never);
    const port = await mock.listen(0, "127.0.0.1");
    paypal = createPayPalClient({
      env: "mock",
      baseUrl: `http://127.0.0.1:${port}`,
      clientId: "c",
      clientSecret: "s",
    });
    await syncAll(paypal, store as never, 20);
  });
  after(() => mock.close());

  it("leaves other paths alone", async () => {
    assert.equal(await call("GET", "/api/cases"), null);
  });

  it("make-offer: 400 without confirm, 400 at the case amount, then 200 and WAITING_FOR_BUYER_RESPONSE", async () => {
    const open = [...rows.values()].find(
      (r) =>
        r.status === "WAITING_FOR_SELLER_RESPONSE" && r.amount_cents > 1000,
    )!;
    const url = `/api/cases/${open.dispute_id}/offer`;
    await assert.rejects(call("POST", url, { amount_cents: 1000 }), {
      code: "confirmation_required",
      status: 400,
    });
    await assert.rejects(
      call("POST", url, { confirm: true, amount_cents: open.amount_cents }),
      { status: 400 },
    );
    const inserts: unknown[][] = [];
    initActivity({
      query: async (sql: string, args: unknown[]) => {
        if (/^insert into paypal_calls/.test(sql)) inserts.push(args);
        return { rows: [] };
      },
    } as never);
    const r = await call("POST", url, { confirm: true, amount_cents: 1000 });
    assert.equal(r!.status, 200);
    await new Promise((res) => setTimeout(res, 20));
    // the log keeps the offer, not the disputed amount
    assert.deepEqual(inserts[0]!.slice(5), [1000, open.currency, "offer"]);
    assert.equal(
      rows.get(open.dispute_id)!.status,
      "WAITING_FOR_BUYER_RESPONSE",
    );
    // the offer link is gone once the offer is made
    await assert.rejects(
      call("POST", url, { confirm: true, amount_cents: 1000 }),
      { status: 409 },
    );
  });

  it("buyer: masked email, never the full address", async () => {
    const any = [...rows.values()][0]!;
    const r = await call("GET", `/api/cases/${any.dispute_id}/buyer`);
    const b = r!.body as Record<string, unknown>;
    assert.equal(b["source"], "mock");
    assert.match(String(b["email_masked"]), /^.•••@example\.com$/);
    assert.ok(b["payer_id"]);
    assert.ok(["VERIFIED", "UNVERIFIED"].includes(String(b["account_status"])));
    assert.doesNotMatch(JSON.stringify(b), /[a-z0-9.]{2,}@/);
    assert.ok((b["ship_to"] as { city: string }).city);
  });

  it("webhook: a dispute event syncs it, an unknown event is ignored", async () => {
    const id = [...rows.keys()][1]!;
    const ok = await call("POST", "/api/webhooks/paypal", {
      event_type: "CUSTOMER.DISPUTE.UPDATED",
      resource: { dispute_id: id },
    });
    assert.deepEqual(ok!.body, {
      verified: "mock",
      dispute_id: id,
      synced: true,
    });
    const ign = await call("POST", "/api/webhooks/paypal", {
      event_type: "PAYMENT.SALE.COMPLETED",
    });
    assert.equal(ign!.status, 200);
    assert.equal((ign!.body as { ignored: boolean }).ignored, true);
    await assert.rejects(call("POST", "/api/webhooks/paypal"), { status: 400 });
  });
});
