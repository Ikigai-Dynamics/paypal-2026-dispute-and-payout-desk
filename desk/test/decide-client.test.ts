import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildDecideRequest,
  callDecide,
  parseDecision,
} from "../src/decide-client.js";
import { toRow } from "../src/sync.js";
import type { Dispute } from "@jeirslab/paypal-client/types";

interface Golden {
  name: string;
  request: Record<string, unknown> & {
    precedents: { dispute_id: string; won: boolean }[];
  };
  expect: Record<string, unknown>;
}
// compiled to dist-test/test/, the fixture stays next to the sources in test/fixtures
const golden = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/decide.v1.cases.json", import.meta.url),
    "utf8",
  ),
) as Golden[];

const dispute = {
  dispute_id: "PP-D-1",
  create_time: "2026-11-01T00:00:00Z",
  update_time: "2026-11-01T00:00:00Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "120.00" },
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  links: [],
  disputed_transactions: [],
  messages: [],
  evidences: [],
} as unknown as Dispute;

describe("decide.v1 client", () => {
  it("has the golden cases, including the three proposal cases", () => {
    const names = golden.map((g) => g.name);
    for (const n of [
      "proposal-120-fight",
      "proposal-9-accept",
      "proposal-64-marginal-fight",
    ])
      assert.ok(names.includes(n), n);
  });

  it("builds a request whose fields match every golden request", () => {
    const req = buildDecideRequest(
      toRow(dispute),
      [{ dispute_id: "a", won: true }],
      { prior: 0.5 },
    );
    const keys = Object.keys(req).sort();
    for (const g of golden)
      assert.deepEqual(Object.keys(g.request).sort(), keys, g.name);
    assert.equal(req.contract, "decide.v1");
    assert.equal(req.amount_cents, 12000);
    assert.equal(req.handling_cost_cents, 1500);
    assert.equal(req.fee_if_lost_cents, 0);
    assert.deepEqual(
      Object.keys(req.precedents[0]!).sort(),
      Object.keys(golden[4]!.request.precedents[0]!).sort(),
    );
  });

  it("parses a response shaped like the golden expectations and rejects a wrong contract", () => {
    for (const g of golden) {
      const d = parseDecision({
        contract: "decide.v1",
        p0_source: "x",
        terms: [],
        ...g.expect,
      });
      assert.equal(d.call, g.expect["call"]);
    }
    assert.throws(() => parseDecision({ contract: "decide.v0" }));
    assert.throws(() =>
      parseDecision({ contract: "decide.v1", call: "fight" }),
    );
  });

  it("posts to /v1/decide and returns the parsed decision", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const g = golden[0]!;
    const fake: typeof fetch = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          contract: "decide.v1",
          p0_source: "x",
          terms: ["t"],
          ...g.expect,
        }),
      );
    };
    const d = await callDecide("http://decide/", g.request as never, fake);
    assert.equal(seen?.url, "http://decide/v1/decide");
    assert.deepEqual(seen?.body, g.request);
    assert.equal(d.call, "fight");
  });
});
