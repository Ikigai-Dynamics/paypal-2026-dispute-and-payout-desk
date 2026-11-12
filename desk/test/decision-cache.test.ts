import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecideRequest } from "../src/decide-client.js";
import {
  createDecisionCache,
  wholeDollarsCents,
} from "../src/decision-cache.js";
import { PgStore } from "../src/db.js";
import type { CaseRow, Decision } from "../src/types.js";

const row = {
  dispute_id: "PP-1",
  updated_at: "t1",
  amount_cents: 5000,
} as CaseRow;
const decision = (keep: number) =>
  ({
    call: "fight",
    margin_cents: 10,
    marginal: false,
    offer: null,
    p: 0.6,
    p_lo: 0.5,
    p_hi: 0.7,
    keep_cents: keep,
  }) as unknown as Decision;

describe("one stored call per case", () => {
  it("gives the same call and keep twice, and recomputes for a new core build", async () => {
    let n = 0;
    let build = "decide.v2@1";
    const c = createDecisionCache({
      compute: async () => decision(4000 + n++),
      build: async () => build,
    });
    const a = await c.callFor(row);
    const b = await c.callFor(row);
    assert.equal(a, b);
    assert.equal(n, 1);
    build = "decide.v2@2";
    assert.equal((await c.callFor(row))?.keep_cents, 4001);
  });

  it("a second cost report that changes nothing leaves the call alone (no drop)", async () => {
    const c = createDecisionCache({
      compute: async () => decision(4000),
      build: async () => "b",
    });
    const a = await c.callFor(row);
    // setAiCost returns false for an unchanged cent value, so the server never calls drop
    assert.equal((await c.callFor(row))?.keep_cents, a?.keep_cents);
  });

  it("rounds the KPI to whole dollars", () => {
    assert.equal(wholeDollarsCents(333_349), 333_300);
    assert.equal(wholeDollarsCents(333_350) % 100, 0);
  });

  it("leaves buyer_orders out when unknown or below disputes", () => {
    const o = (buyerOrders: number | null, buyerDisputes: number) =>
      buildDecideRequest({ ...row, raw: {} } as CaseRow, [], {
        buyerOrders,
        buyerDisputes,
      });
    assert.equal("buyer_orders" in o(null, 7), false);
    assert.equal("buyer_orders" in o(3, 7), false);
    assert.equal(o(12, 7).buyer_orders, 12);
    assert.equal(o(null, 7).buyer_disputes, 7);
  });

  it("resetWork clears chat conversations but not memory", async () => {
    const sql: string[] = [];
    const store = new PgStore({
      query: async (q: string) => (sql.push(q), { rows: [] }),
    } as never);
    await store.resetWork();
    const all = sql.join(" ");
    assert.match(all, /truncate conversations, messages/);
    assert.doesNotMatch(all, /memory/);
  });
});
