import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm } from "@jeirslab/llm-client";
import {
  busyReply,
  chatRoutes,
  labelIds,
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
  item: "Ember Sleeping Bag",
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
        [{ type: "make_dispute_offer", case_id: "PP-1", amount_cents }],
        deps,
      );
      assert.equal(r.staged.length, 0, String(amount_cents));
    }
  });
  it("stages an offer with the PayPal call and defaults to the decision's offer", async () => {
    const r = await validateActions(
      [{ type: "make_dispute_offer", case_id: "PP-1" }],
      deps,
    );
    const s = r.staged[0]!;
    assert.equal(
      s.title,
      "Offer $12.50 back to Dana Rivera on the Ember Sleeping Bag dispute",
    );
    assert.equal(s.paypal.path, "/v1/customer/disputes/PP-1/make-offer");
    assert.deepEqual(s.desk.body, {
      confirm: true,
      amount_cents: 1250,
      offer_type: "REFUND",
    });
  });
  it("maps the old action names and a JSON reply only stages a card", async () => {
    const p = parseReply(
      '```json\n{"reply":"Offering.","actions":[{"type":"make_dispute_offer","case_id":"PP-1","amount_cents":2000}]}\n```',
    );
    const r = await validateActions(p.actions, deps);
    assert.equal(r.staged.length, 1);
    assert.equal(r.staged[0]!.kind, "make_dispute_offer");
    assert.equal(r.ui.length, 0);
    const old = await validateActions(
      [
        { type: "make_offer", case_id: "PP-1" },
        { type: "accept_claim", case_id: "PP-1" },
      ],
      deps,
    );
    assert.deepEqual(
      old.staged.map((s) => s.kind),
      ["make_dispute_offer", "accept_dispute_claim"],
    );
    const g = await validateActions(
      [{ type: "get_dispute", case_id: "PP-1" }],
      deps,
    );
    assert.deepEqual(g.ui, [{ type: "select_case", id: "PP-1" }]);
  });
  it("stages evidence with the saved draft and opens the draft tab", async () => {
    const r = await validateActions(
      [{ type: "provide_dispute_evidence", case_id: "PP-1" }],
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

describe("case labels and the busy fallback", () => {
  const cases = [
    {
      id: "PP-D-1",
      buyer: "Marcus Bell",
      item: "Ember 20F Sleeping Bag",
      amount_cents: 17900,
    },
    { id: "PP-D-10", buyer: "Ava Chen", amount_cents: 5000 },
  ];
  it("replaces ids with item · buyer · amount, longest id first", () => {
    const t = labelIds("Offer on PP-D-1, refund PP-D-10.", cases);
    assert.equal(
      t,
      "Offer on Ember 20F Sleeping Bag · Marcus Bell · $179.00, refund Ava Chen · $50.00.",
    );
    assert.doesNotMatch(t, /PP-D-/);
  });
  it("busy fallback uses human call words and never says offline", () => {
    assert.equal(
      busyReply({ ...ctx, call: "offer", offer_cents: 9750 }),
      "Parley's AI is busy right now. Here is the desk's call for this case: Offer $97.50 back.",
    );
    assert.match(busyReply({ ...ctx, call: "accept" }), /Refund in full\.$/);
    assert.match(busyReply({ ...ctx, call: "fight" }), /Fight it\.$/);
    assert.doesNotMatch(busyReply(null), /offline|couldn't/);
  });
});

describe("staged offer note", () => {
  const offer = (c: CaseCtx, cents: number) =>
    validateActions(
      [{ type: "make_dispute_offer", case_id: c.id, amount_cents: cents }],
      { loadCase: async () => c, listCases: async () => [] },
    );
  it("says what Parley suggests when the amount differs", async () => {
    const r = await offer({ ...ctx, call: "offer", offer_cents: 4000 }, 3000);
    assert.equal(
      r.staged[0]!.note,
      "Parley suggests $40.00; you asked $30.00.",
    );
    assert.equal(
      (await offer({ ...ctx, call: "offer", offer_cents: 3000 }, 3000))
        .staged[0]!.note,
      undefined,
    );
  });
  it("names the call when it is fight or refund", async () => {
    assert.equal(
      (await offer({ ...ctx, call: "fight" }, 3000)).staged[0]!.note,
      "Parley's call on this case is Fight it.",
    );
  });
});
