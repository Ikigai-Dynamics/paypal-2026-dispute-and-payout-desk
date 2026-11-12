import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm } from "@jeirslab/llm-client";
import {
  chatRoutes,
  parseReply,
  validateActions,
  type CaseCtx,
  type ChatDeps,
} from "../src/chat.js";

const ctx: CaseCtx = {
  id: "PP-1",
  buyer: "Dana Rivera",
  amount_cents: 5000,
  currency: "USD",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  call: "accept",
  offer_cents: 1250,
  draft_text: "We shipped it.",
};
const deps = {
  loadCase: async (id: string) => (id === "PP-1" ? ctx : null),
  listCases: async () => [
    { id: "PP-1", buyer: "Dana Rivera", amount_cents: 5000, call: "accept" },
  ],
};

describe("validateActions", () => {
  it("drops unknown types, bad tabs and unknown cases", async () => {
    const r = await validateActions(
      [
        { type: "rm_rf" },
        { type: "open_tab", tab: "nope" },
        { type: "select_case", id: "X" },
        null,
        { type: "open_tab", tab: "Buyer" },
      ],
      deps,
    );
    assert.deepEqual(r.ui, [{ type: "open_tab", tab: "buyer" }]);
    assert.equal(r.staged.length, 0);
  });
  it("filters to known ids only", async () => {
    const r = await validateActions(
      [{ type: "filter", ids: ["PP-1", "X"] }],
      deps,
    );
    assert.deepEqual(r.ui, [{ type: "filter", ids: ["PP-1"] }]);
  });
  it("rejects an offer at or above the case amount, or not an integer", async () => {
    for (const amount_cents of [5000, 6000, 0, -5, 12.5, "9"]) {
      const r = await validateActions(
        [{ type: "make_offer", case_id: "PP-1", amount_cents }],
        deps,
      );
      assert.equal(r.staged.length, 0, String(amount_cents));
    }
  });
  it("stages an offer with the PayPal call and defaults to the decision's offer", async () => {
    const r = await validateActions(
      [{ type: "make_offer", case_id: "PP-1" }],
      deps,
    );
    const s = r.staged[0]!;
    assert.equal(s.title, "Offer $12.50 to Dana R.");
    assert.equal(s.paypal.path, "/v1/customer/disputes/PP-1/make-offer");
    assert.deepEqual(s.desk.body, {
      confirm: true,
      amount_cents: 1250,
      offer_type: "REFUND",
    });
  });
  it("stages evidence with the saved draft and opens the draft tab", async () => {
    const r = await validateActions(
      [{ type: "provide_evidence", case_id: "PP-1" }],
      deps,
    );
    assert.deepEqual(r.ui, [{ type: "open_tab", tab: "draft" }]);
    assert.equal(r.staged[0]!.desk.path, "/api/cases/PP-1/evidence");
  });
});

describe("parseReply", () => {
  it("reads fenced JSON", () => {
    const r = parseReply(
      'Sure\n```json\n{"reply":"Hi","actions":[{"type":"open_tab","tab":"buyer"}]}\n```',
    );
    assert.equal(r.reply, "Hi");
    assert.equal(r.actions.length, 1);
  });
  it("falls back to plain text", () => {
    assert.deepEqual(parseReply("Just text."), {
      reply: "Just text.",
      actions: [],
    });
  });
});

describe("chatRoutes", () => {
  it("returns null off the chat prefix", async () => {
    assert.equal(
      await chatRoutes(
        Object.assign((async function* () {})(), { method: "GET" }),
        new URL("http://x/api/cases"),
        {} as ChatDeps,
      ),
      null,
    );
  });
  it("'remember X' stores a fact without the model", async () => {
    const facts: string[] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("insert into memory")) facts.push(params[0] as string);
        if (sql.includes("from conversations where id"))
          return { rows: [{ id: "1", title: "New chat", case_id: null }] };
        if (sql.includes("insert into messages") && sql.includes("returning"))
          return { rows: [{ id: "2", role: "parley", text: params[1] }] };
        return { rows: [] };
      },
    };
    const req = Object.assign(
      (async function* () {
        yield Buffer.from(
          JSON.stringify({ text: "remember I ship with USPS" }),
        );
      })(),
      { method: "POST" },
    );
    const r = await chatRoutes(
      req,
      new URL("http://x/api/chat/conversations/1/messages"),
      { pool, llm: createLlm({ env: {} }), ...deps },
    );
    assert.equal(r?.status, 200);
    assert.deepEqual(facts, ["I ship with USPS"]);
  });
});
