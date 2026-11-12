import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm } from "@jeirslab/llm-client";
import {
  busyReply,
  chatRoutes,
  labelIds,
  money,
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
    assert.deepEqual(r.ui, [{ type: "select_case", id: "PP-1" }]);
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
    assert.deepEqual(r.ui, [
      { type: "open_tab", tab: "draft" },
      { type: "select_case", id: "PP-1" },
    ]);
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

describe("grounded chat", () => {
  const mk = (
    id: string,
    buyer: string,
    item: string,
    cents: number,
    call: string,
    due: number,
    reason: string,
    offer?: number,
  ) => ({
    id,
    buyer,
    item,
    amount_cents: cents,
    currency: "USD",
    call,
    due_in_days: due,
    reason,
    status_group: "needs_you" as const,
    offer_cents: offer ?? null,
  });
  const list = [
    mk(
      "I",
      "Pat Lee",
      "Ikigai Gift Card",
      10000,
      "fight",
      3,
      "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    ),
    mk(
      "A",
      "Sam Alder",
      "Alder Boots",
      16400,
      "accept",
      1,
      "CREDIT_NOT_PROCESSED",
    ),
    mk(
      "E",
      "Marcus Bell",
      "Ember Sleeping Bag",
      17900,
      "offer",
      5,
      "DUPLICATE_TRANSACTION",
      9750,
    ),
    mk("S1", "Ann Hill", "Summit Tent", 131700, "fight", 6, "UNAUTHORISED"),
    mk(
      "S2",
      "Bo Park",
      "Summit Tent",
      60800,
      "fight",
      7,
      "PAYMENT_BY_OTHER_MEANS",
    ),
  ];
  const run = async (
    text: string,
    cases: (Omit<(typeof list)[number], "status_group"> & {
      status_group: "needs_you" | "waiting";
      sent_offer_cents?: number;
    })[] = list,
  ) => {
    let llmCalls = 0;
    const saved: { actions: string }[] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("from conversations where id"))
          return { rows: [{ id: "1", title: "x", case_id: null }] };
        if (sql.includes("select fact"))
          return { rows: [{ fact: "I always refund gift cards under $50" }] };
        if (sql.includes("select role, text")) return { rows: [] };
        if (sql.includes("insert into messages") && sql.includes("returning")) {
          saved.push({ actions: params[2] as string });
          return {
            rows: [
              {
                id: "2",
                role: "parley",
                text: params[1],
                actions: JSON.parse(params[2] as string),
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const llm = {
      complete: async () => {
        llmCalls++;
        return {
          source: "llm",
          value: JSON.stringify({
            reply: "Ok.",
            actions: [
              {
                type: "make_dispute_offer",
                case_id: "S1",
                amount_cents: 25000,
              },
            ],
          }),
        };
      },
    } as unknown as ChatDeps["llm"];
    const req = Object.assign(
      (async function* () {
        yield Buffer.from(JSON.stringify({ text }));
      })(),
      { method: "POST" },
    );
    const r = await chatRoutes(
      req,
      new URL("http://x/api/chat/conversations/1/messages"),
      {
        pool,
        llm,
        loadCase: async (id) => {
          const c = cases.find((x) => x.id === id);
          return c ? { ...c, offer_cents: c.offer_cents ?? undefined } : null;
        },
        listCases: async () => cases,
      },
    );
    return { body: r!.body as any, llmCalls }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it("formats money with thousands separators", () => {
    assert.equal(money(131700), "$1,317.00");
  });
  it("answers 'first' from the desk's call without the model", async () => {
    const { body, llmCalls } = await run(
      "Which case should I deal with first, and why?",
    );
    assert.equal(llmCalls, 0);
    assert.match(
      body.message.text,
      /^Start with Alder Boots · Sam Alder · \$164\.00\. It's due tomorrow, and the desk's call is Refund in full\./,
    );
    assert.doesNotMatch(body.message.text, /Ikigai.*refund/i);
    assert.deepEqual(body.ui_actions, [{ type: "select_case", id: "A" }]);
  });
  it("lists the refund cases outside the text", async () => {
    const { body, llmCalls } = await run("Which cases should I just refund?");
    assert.equal(llmCalls, 0);
    assert.equal(body.message.text, "Refund these 1 in full:");
    assert.deepEqual(body.list, [
      { id: "A", line: "Alder Boots · Sam Alder · $164.00 · due tomorrow" },
    ]);
    assert.deepEqual(body.ui_actions[0], { type: "filter", ids: ["A"] });
  });
  it("says so when no case has that call", async () => {
    const { body } = await run(
      "Which should I offer on?",
      list.filter((c) => c.call !== "offer"),
    );
    assert.match(body.message.text, /^None of your open cases/);
  });
  it("stages on the case the text names, over the model's id", async () => {
    const { body } = await run(
      "Offer $250 on the Summit tent where they paid another way",
    );
    assert.equal(body.staged.length, 1);
    assert.match(body.staged[0].desk.path, /\/S2\/offer$/);
  });
  it("asks which one when two cases tie", async () => {
    const { body } = await run("Offer $250 on the Summit tent");
    assert.equal(body.staged.length, 0);
    assert.equal(body.message.text, "Which one do you mean?");
    assert.deepEqual(
      body.list.map((l: { line: string }) => l.line),
      [
        "Summit Tent · Ann Hill · Unauthorised · $1,317.00 · due in 6 days",
        "Summit Tent · Bo Park · Paid another way · $608.00 · due in 7 days",
      ],
    );
  });
  it("resolves 'send the offer' to the one open offer case, with no model", async () => {
    const cs = [
      ...list,
      mk(
        "S3",
        "Marcus Bell",
        "Summit Tent",
        60800,
        "offer",
        4,
        "PAYMENT_BY_OTHER_MEANS",
        28000,
      ),
    ];
    const { body, llmCalls } = await run(
      "Send the offer to Marcus Bell on the Summit Tent ($280)",
      cs,
    );
    assert.equal(llmCalls, 0);
    assert.equal(body.staged.length, 1);
    assert.match(body.staged[0].desk.path, /\/S3\/offer$/);
    assert.deepEqual(body.ui_actions.at(-1), { type: "select_case", id: "S3" });
    assert.deepEqual(body.staged[0].paypal.body, {
      offer_amount: { currency_code: "USD", value: "280.00" },
      offer_type: "REFUND",
    });
  });
  it("says so when that offer is already out", async () => {
    const cs = [
      ...list,
      {
        ...mk(
          "S3",
          "Marcus Bell",
          "Summit Tent",
          60800,
          "offer",
          4,
          "PAYMENT_BY_OTHER_MEANS",
          28000,
        ),
        status_group: "waiting" as const,
        sent_offer_cents: 28000,
      },
    ];
    const { body } = await run(
      "Send the offer to Marcus Bell on the Summit Tent ($280)",
      cs,
    );
    assert.equal(body.staged.length, 0);
    assert.equal(body.message.text, "You already offered $280.00 on that one.");
  });
  it("counts 'due this week' like the list: open cases within 7 days, with whole-day wording", async () => {
    const cs = [
      ...list,
      mk("L", "Late Lee", "Far Tent", 9000, "fight", 8, "OTHER"),
      {
        ...mk("W", "Wai Ting", "Sent Tent", 9000, "offer", 2, "OTHER"),
        status_group: "waiting" as const,
      },
    ];
    const { body } = await run("Which disputes are due this week?", cs);
    assert.equal(body.message.text, "5 disputes are due this week:");
    assert.equal(body.list.length, 5);
    assert.equal(
      body.list[0].line,
      "Alder Boots · Sam Alder · $164.00 · due tomorrow",
    );
  });
  it("collapses duplicated labels and bare ids", () => {
    const cs = [
      { id: "PP-D-1", buyer: "Ava Chen", item: "Boots", amount_cents: 5000 },
    ];
    assert.equal(
      labelIds("Refund Boots · Ava Chen · $50.00 (PP-D-1) now (PP-D-9).", cs),
      "Refund Boots · Ava Chen · $50.00 now.",
    );
    assert.equal(
      labelIds("Refund PP-D-1 (PP-D-1).", cs),
      "Refund Boots · Ava Chen · $50.00.",
    );
  });
});
