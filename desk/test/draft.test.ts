import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm } from "@jeirslab/llm-client";
import {
  buildChecklist,
  explanationOf,
  sentencesOf,
  draftResponse,
  fallbackDraft,
  groundingProblems,
  invalidReason,
  positionFor,
  positionOf,
  isDraftShape,
  withAdded,
} from "../src/draft.js";
import { DraftCache, pool, stopAfterDown } from "../src/drafts.js";
import { proofText, unsupportedClaims } from "../src/factcheck.js";
import type { CaseView, Decision, Draft } from "../src/types.js";

const base: CaseView = {
  dispute_id: "PP-D-1",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  stage: "INQUIRY",
  status: "WAITING_FOR_SELLER_RESPONSE",
  outcome: null,
  amount_cents: 12000,
  currency: "USD",
  buyer: "Ava Chen",
  merchant: "Ikigai Outfitters",
  updated_at: "2026-11-06T00:00:00Z",
  due_at: null,
  days_left: 5,
  evidence_on_file: false,
  messages: [
    {
      posted_by: "BUYER",
      time_posted: "2026-11-06T00:00:00Z",
      content: "Never arrived",
    },
  ],
  items: [{ item_description: "Hardware kit #1234", item_quantity: "2" }],
  evidences: [],
};
const withTracking: CaseView = {
  ...base,
  evidence_on_file: true,
  evidences: [
    {
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: {
        tracking_info: [
          { carrier_name: "UPS", tracking_number: "1Z999AA10123456784" },
        ],
      },
      notes: "Shipped with tracking; delivery confirmation attached.",
    },
  ],
};
const decision: Decision = {
  contract: "decide.v1",
  p0: 0.45,
  p0_source: "assumed",
  k: 4,
  wins: 0,
  n: 0,
  p: 0.45,
  ev_accept_cents: -12000,
  ev_fight_cents: -7500,
  margin_cents: 4500,
  marginal: true,
  call: "fight",
  terms: ["term one", "term two"],
};

describe("fallback draft", () => {
  it("is deterministic", () => {
    assert.deepEqual(
      fallbackDraft(base, decision),
      fallbackDraft(base, decision),
    );
  });

  it("marks tracking missing and cites no tracking number when none is on file", () => {
    const d = fallbackDraft(base, decision);
    const tracking = d.checklist.find((c) => c.item === "Tracking number");
    assert.equal(tracking?.status, "missing");
    assert.ok(!/1Z|\d{9,}/.test(d.response));
    assert.ok(
      d.response.includes("Ava Chen") &&
        d.response.includes("USD 120.00") &&
        d.response.includes("Hardware kit #1234"),
    );
  });

  it("cites the tracking number only when it is on the case", () => {
    const d = fallbackDraft(withTracking, decision);
    assert.ok(d.response.includes("UPS tracking number 1Z999AA10123456784"));
    assert.equal(
      d.checklist.find((c) => c.item === "Tracking number")?.status,
      "present",
    );
    assert.equal(
      d.checklist.find((c) => c.item === "Delivery confirmation")?.status,
      "present",
    );
  });

  it("explanation is one plain sentence, and says so when there is no decision", () => {
    assert.equal(
      fallbackDraft(base, decision).explanation,
      "We recommend fighting: about 45% chance of winning, a loss costs you only the refund you would give anyway, and fighting costs about $15.",
    );
    assert.match(fallbackDraft(base, null).explanation, /unreachable/);
  });

  it("has no Re: header and never shows the dispute id, a reason or 'facts below'", () => {
    const r = fallbackDraft(base, decision).response;
    assert.ok(!/^Re:/.test(r));
    assert.ok(!/PP-D-|not received|NOT_RECEIVED|facts below/.test(r));
    assert.ok(
      r.startsWith(
        "We ask PayPal to review whether the order was fulfilled as placed.",
      ),
    );
  });

  it("explains an accept in the case currency", () => {
    const c = { currency: "EUR", amount_cents: 900 };
    assert.equal(
      explanationOf({ ...decision, call: "accept" }, c),
      "We recommend accepting: about 45% chance of winning; fighting costs about €15, more than the €9 you could win back.",
    );
  });

  it("cites the evidence on file in an unauthorised fallback", () => {
    const marcus: CaseView = {
      ...base,
      reason: "UNAUTHORISED",
      buyer: "Marcus Bell",
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: {
            tracking_info: [
              { carrier_name: "UPS", tracking_number: "1Z999AA10123456784" },
            ],
          },
          notes:
            "Two tents shipped by UPS to the billing address; signature on delivery.",
        },
      ],
    };
    const r = fallbackDraft(marcus, decision).response;
    assert.ok(r.includes("1Z999AA10123456784"));
    assert.ok(r.includes("shipped by UPS to the billing address"));
    assert.equal(invalidReason(r, r, r), null);
  });

  it("gives digital goods an email-log checklist with a suggestion", () => {
    const gift: CaseView = {
      ...base,
      items: [
        { item_description: "Ikigai Gift Card $100", item_quantity: "1" },
      ],
      purchased_at: "2026-10-30T00:00:00.000Z",
      messages: [
        {
          posted_by: "SELLER",
          time_posted: "2026-11-06T00:00:00Z",
          content: "The code was emailed on the day of purchase.",
        },
      ],
    };
    const list = buildChecklist(gift);
    assert.ok(!list.some((i) => i.item === "Tracking number"));
    assert.deepEqual(
      list.map((i) => i.item),
      ["Proof the code was sent (email log)", "Code redemption record"],
    );
    assert.equal(
      list[0]?.suggestion?.label,
      "Attach email log: code sent Oct 30, 2026",
    );
    assert.equal(list[1]?.suggestion, undefined);
  });

  it("suggests the buyer's earlier orders", () => {
    const l = buildChecklist({
      ...base,
      reason: "UNAUTHORISED",
      buyer: "Marcus Bell",
      buyer_history: [
        {
          dispute_id: "x",
          date: "2026-10-03T00:00:00Z",
          amount_cents: 60800,
          items: "1 × Summit 4P Basecamp Tent",
        },
      ],
    });
    assert.equal(
      l[1]?.suggestion?.label,
      "Attach order history: 1 other order",
    );
    assert.match(
      l[1]?.suggestion?.note ?? "",
      /Oct 3, 2026, \$608\.00 \(1 × Summit 4P Basecamp Tent\)/,
    );
  });

  it("has a checklist per reason", () => {
    const items = (reason: string) =>
      buildChecklist({ ...base, reason }).map((c) => c.item);
    assert.deepEqual(items("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"), [
      "Listing description",
      "Photos of the item",
      "Return policy",
    ]);
    assert.deepEqual(items("UNAUTHORISED"), [
      "Shipping address matches the buyer",
      "Prior orders from this buyer",
    ]);
    assert.deepEqual(items("DUPLICATE_TRANSACTION"), [
      "Proof the two charges are separate orders",
    ]);
    assert.deepEqual(items("CREDIT_NOT_PROCESSED"), [
      "Return received record",
      "Refund issued",
    ]);
    assert.equal(items("OTHER").length, 2);
  });

  it("requires exactly one item per reason", () => {
    for (const reason of [
      "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      "UNAUTHORISED",
      "DUPLICATE_TRANSACTION",
      "CREDIT_NOT_PROCESSED",
      "OTHER",
    ])
      assert.equal(
        buildChecklist({ ...base, reason }).filter((i) => i.required).length,
        1,
        reason,
      );
    const digital = buildChecklist({
      ...base,
      items: [{ item_description: "Gift Card", item_quantity: "1" }],
    });
    assert.deepEqual(
      digital.map((i) => i.required),
      [true, false],
    );
  });

  it("fallbacks claim nothing when no evidence is on file", () => {
    const stems =
      /ship|deliver|e-?mail|re-?sent|\blogs?\b|record|tracking|signature|only one|redeem/i;
    for (const reason of [
      "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      "UNAUTHORISED",
      "DUPLICATE_TRANSACTION",
      "CREDIT_NOT_PROCESSED",
      "CANCELED_RECURRING_BILLING",
      "OTHER",
    ])
      assert.doesNotMatch(
        fallbackDraft({ ...base, reason }, decision).response,
        stems,
        reason,
      );
  });

  it("marks the listing description present only when evidence mentions it", () => {
    const listing = (c: CaseView) =>
      buildChecklist({
        ...c,
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      }).find((i) => i.item === "Listing description");
    // items exist but no evidence mentions the listing
    assert.equal(base.items.length > 0, true);
    assert.equal(listing(base)?.status, "missing");
    assert.equal(listing(withTracking)?.status, "missing");
    const withListing: CaseView = {
      ...base,
      evidences: [
        {
          evidence_type: "OTHER",
          evidence_info: {},
          notes: "Screenshot of the listing description as published.",
        },
      ],
    };
    assert.equal(listing(withListing)?.status, "present");
  });
});

describe("response validator", () => {
  const input = JSON.stringify({ tracking: ["UPS 1Z999AA10123456784"] });
  it("rejects invented numbers, placeholders, salutations and recommendations", () => {
    assert.match(
      invalidReason("Order 12345678901234567890 shipped.", input) ?? "",
      /not in the input/,
    );
    assert.ok(invalidReason("Shipped on [date].", input));
    assert.ok(invalidReason("Dear Priya, thanks.", input));
    assert.ok(invalidReason("we recommend fighting", input));
    assert.equal(
      invalidReason(
        "Tracking 1Z999AA10123456784 shows delivery for $1,317.00.",
        input,
      ),
      null,
    );
  });
  it("retries once with the reason, then falls back with an error", async () => {
    let calls = 0;
    const llm = createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ response: "Dear Ava, hi" }),
                },
              },
            ],
          }),
        );
      },
    });
    const d = await draftResponse(llm, base, decision, []);
    assert.equal(calls, 2);
    assert.equal(d.source, "fallback");
    assert.match(d.error ?? "", /addressed the buyer/);
  });
});

const REPLY =
  "We ask PayPal to review whether the order was fulfilled as placed. The order was for 2 × Hardware kit #1234. We ask PayPal to find in our favour.";
describe("draftResponse", () => {
  it("uses the fallback offline and labels it", async () => {
    const d = await draftResponse(createLlm({ env: {} }), base, decision, []);
    assert.equal(d.source, "fallback");
    assert.equal(d.label, "Draft (AI unavailable)");
    assert.ok(d.error);
  });

  it("uses a well-shaped LLM reply and labels the model", async () => {
    const llm = createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    response: REPLY,
                    checklist: [{ item: "i", status: "missing", why: "w" }],
                    explanation: "E",
                  }),
                },
              },
            ],
          }),
        ),
    });
    const d = await draftResponse(llm, base, decision, []);
    assert.deepEqual(
      [d.source, d.model, d.response, d.label],
      ["llm", "m1", REPLY, "AI draft"],
    );
  });

  it("replaces the model's checklist with the computed one", async () => {
    const llm = createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    response: `${REPLY} The UPS tracking number is on file.`,
                    checklist: [{ item: "Bogus", status: "present", why: "w" }],
                    explanation: "E",
                  }),
                },
              },
            ],
          }),
        ),
    });
    const d = await draftResponse(llm, withTracking, decision, []);
    assert.equal(d.source, "llm");
    assert.deepEqual(d.checklist, buildChecklist(withTracking));
  });

  it("falls back with an error when the LLM shape is wrong", async () => {
    const llm = createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ response: 5 }) } },
            ],
          }),
        ),
    });
    const d = await draftResponse(llm, base, decision, []);
    assert.equal(d.source, "fallback");
    assert.match(d.error ?? "", /shape/);
    assert.ok(isDraftShape(fallbackDraft(base, decision)));
  });
});

describe("grounding", () => {
  const gift: CaseView = {
    ...base,
    buyer: "Sofia Lindqvist",
    items: [{ item_description: "Ikigai Gift Card $100", item_quantity: "1" }],
    purchased_at: "2026-10-30T00:00:00.000Z",
  };
  const fake = (texts: string[], seen: string[] = []) => {
    let n = 0;
    return createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async (_u, init) => {
        seen.push(String(init?.body));
        const t = texts[Math.min(n++, texts.length - 1)]!;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ response: t }) } },
            ],
          }),
        );
      },
    });
  };
  const reviewer = [
    "Re: Ava. The order was processed on October 14, 2026, and shipped promptly, with tracking information via email.",
    "We confirm only one order was processed on November 3, 2026.",
    "The order was shipped on October 17, 2026.",
    "We have reviewed our email delivery logs and found no bounce.",
  ];
  for (const text of reviewer)
    it(`rejects: ${text.slice(0, 40)}`, async () => {
      const d = await draftResponse(fake([text]), gift, decision, []);
      assert.equal(d.source, "fallback");
      assert.ok(d.error);
      assert.ok(!d.response.includes(text));
    });

  it("rejects 're-sent' when the note only says the code can be re-sent", async () => {
    const d = await draftResponse(
      fake(["We have re-sent the code to the buyer's email address."]),
      gift,
      decision,
      [],
      undefined,
      [
        {
          item: "Code redemption record",
          note: "code IKG-100 has not been redeemed; it is still valid and can be re-sent",
        },
      ],
    );
    assert.equal(d.source, "fallback");
    assert.doesNotMatch(d.response, /We have re-sent/);
  });

  it("accepts a claim the notes make", () => {
    assert.equal(
      invalidReason("The order shipped by UPS.", "x", "Shipped by UPS"),
      null,
    );
  });

  it("uses the full name, splits the messages and never lists what we lack", async () => {
    const seen: string[] = [];
    const d = await draftResponse(
      fake(
        [
          "Re: Sofia's claim. The charge was made through the buyer's PayPal account. We hold the order as it was placed. We ask PayPal to find in our favour.",
        ],
        seen,
      ),
      {
        ...gift,
        messages: [
          { posted_by: "BUYER", time_posted: "t", content: "No code came" },
          { posted_by: "SELLER", time_posted: "t", content: "It was emailed" },
        ],
      },
      decision,
      [],
    );
    assert.equal(d.source, "llm");
    assert.doesNotMatch(d.response, /^Re:/);
    const sent = JSON.parse(JSON.parse(seen[0]!).messages.at(-1).content);
    assert.ok(sent.facts_on_file.some((f: string) => /No code came/.test(f)));
    assert.ok(
      !sent.facts_on_file.some((f: string) => /It was emailed/.test(f)),
    );
    assert.equal(sent.our_earlier_messages, undefined);
    assert.equal(sent.evidence_we_still_lack, undefined);
  });
});

describe("grounded drafting over the seeded cases", () => {
  const seeded = (o: Partial<CaseView>): CaseView => ({
    ...base,
    merchant: "Ikigai Outfitters",
    currency: "USD",
    ...o,
  });
  const msg = (posted_by: "BUYER" | "SELLER", content: string) => ({
    posted_by,
    time_posted: "2026-11-05T00:00:00Z",
    content,
  });
  const bag = seeded({
    dispute_id: "PP-D-3237289029",
    reason: "OTHER",
    buyer: "Marcus Bell",
    amount_cents: 17900,
    purchased_at: "2026-10-17T05:03:00.282Z",
    items: [{ item_quantity: "1", item_description: "Ember 20F Sleeping Bag" }],
    messages: [
      msg(
        "BUYER",
        "There is a problem with this payment and I need help resolving it.",
      ),
      msg(
        "SELLER",
        "We are sorry to hear that. Can you send a photo of the item and the packaging?",
      ),
    ],
    buyer_history: [
      {
        dispute_id: "PP-D-2",
        date: "2026-10-11T04:23:45.569Z",
        amount_cents: 11800,
        items: "2 × Pocket Canister Stove",
      },
    ],
  });
  const tent = seeded({
    dispute_id: "PP-D-1724441021",
    reason: "PAYMENT_BY_OTHER_MEANS",
    stage: "PRE_ARBITRATION",
    buyer: "Marcus Bell",
    amount_cents: 60800,
    purchased_at: "2026-10-13T07:44:27.891Z",
    items: [
      { item_quantity: "1", item_description: "Summit 4P Basecamp Tent" },
      { item_quantity: "1", item_description: "Pocket Canister Stove" },
    ],
    messages: [
      msg(
        "BUYER",
        "There is a problem with this payment and I need help resolving it.",
      ),
      msg(
        "BUYER",
        "I already contacted you twice with photos and got no reply.",
      ),
    ],
  });
  const hana = seeded({
    dispute_id: "PP-D-8916749540",
    reason: "UNAUTHORISED",
    buyer: "Hana Kobayashi",
    amount_cents: 16400,
    purchased_at: "2026-10-27T23:50:36.515Z",
    items: [
      { item_quantity: "1", item_description: "Alder Waterproof Hiking Boots" },
    ],
    messages: [
      msg(
        "BUYER",
        "I did not authorise Alder Waterproof Hiking Boots; my card was stolen last month.",
      ),
    ],
    buyer_history: [
      {
        dispute_id: "PP-D-1",
        date: "2026-10-14T02:01:11.625Z",
        amount_cents: 20300,
        items:
          "1 × Alder Waterproof Hiking Boots, 1 × Lumen Rechargeable Headlamp",
      },
      {
        dispute_id: "PP-D-9",
        date: "2026-10-20T02:01:11.625Z",
        amount_cents: 3900,
        items: "1 × Lumen Rechargeable Headlamp",
        disputed: true,
      } as never,
    ],
  });
  const priya = seeded({
    dispute_id: "PP-D-DUPLICATE-0003",
    reason: "DUPLICATE_TRANSACTION",
    buyer: "Priya Nair",
    amount_cents: 16400,
    purchased_at: "2026-11-03T21:55:43.450Z",
    items: [
      { item_quantity: "1", item_description: "Alder Waterproof Hiking Boots" },
    ],
    messages: [
      msg(
        "BUYER",
        "I was charged twice for one pair of Alder boots, three minutes apart. I only placed one order.",
      ),
    ],
  });
  const GOOD =
    "The charge was made through the buyer's PayPal account. We hold the order as it was placed. We ask PayPal to find in our favour.";
  const cases: [string, CaseView, string][] = [
    ["Marcus Bell sleeping bag", bag, GOOD],
    ["Marcus Bell tent", tent, GOOD],
    ["Hana Kobayashi", hana, GOOD],
    ["Priya Nair", priya, GOOD],
  ];
  const bad = [
    "We are providing the item in evidence we still lack. There is no evidence on file. We have enclosed the available documentation.",
    "We provide the email log, which is included in our evidence we still lack. We ask PayPal to find in our favour.",
    "We are providing the items in evidence we still lack, without claiming what they show.",
    "The buyer has proof that the two charges are related to the same transaction. We apologise for the duplicate charge.",
    "Our position is clear. We have attached the delivery confirmation. We ask PayPal to find in our favour.",
  ];
  const fake = (texts: string[], seen: string[] = []) => {
    let n = 0;
    return createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async (_u, init) => {
        seen.push(String(init?.body));
        const t = texts[Math.min(n++, texts.length - 1)]!;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ response: t }) } },
            ],
          }),
        );
      },
    });
  };
  const factsOf = (c: CaseView) =>
    c.evidences.map((e) => e.notes ?? "").join(" ");
  const assertClean = (c: CaseView, response: string, facts: boolean) => {
    const checklist = buildChecklist(c);
    assert.deepEqual(groundingProblems(response, checklist, factsOf(c)), []);
    assert.doesNotMatch(response, /lack/i);
    if (!facts) assert.doesNotMatch(response, /enclos|providing|attached/i);
    if (c.reason === "DUPLICATE_TRANSACTION")
      assert.doesNotMatch(response, /same transaction/i);
  };

  for (const [name, c, good] of cases) {
    it(`${name}: every known bad draft is replaced by a grounded one`, async () => {
      for (const b of bad) {
        const d = await draftResponse(fake([b, good]), c, decision, []);
        assert.equal(d.source, "llm", b);
        assertClean(c, d.response, false);
      }
    });

    it(`${name}: the prompt shows only facts on file`, async () => {
      const seen: string[] = [];
      await draftResponse(fake([good], seen), c, decision, []);
      const content = JSON.parse(seen[0]!).messages.at(-1).content as string;
      assert.doesNotMatch(content, /lack/i);
      for (const i of buildChecklist(c).filter((x) => x.status === "missing"))
        assert.ok(!content.includes(i.item), i.item);
      assert.ok(
        !JSON.parse(content).facts_on_file.some((f: string) =>
          /^Evidence on file/.test(f),
        ),
      );
    });

    it(`${name}: an offline model gets the grounded template`, async () => {
      const d = await draftResponse(createLlm({ env: {} }), c, decision, []);
      assert.equal(d.source, "fallback");
      assertClean(c, d.response, false);
      assert.deepEqual(
        groundingProblems(
          fallbackDraft(c, decision).response,
          buildChecklist(c),
          "",
        ),
        [],
      );
    });

    it(`${name}: two ungrounded drafts fall back to the template`, async () => {
      const d = await draftResponse(fake([bad[0]!]), c, decision, []);
      assert.equal(d.source, "fallback");
      assert.match(d.error ?? "", /not allowed/);
      assertClean(c, d.response, false);
    });
  }

  it("regenerates exactly once and tells the model which sentence was rejected", async () => {
    const seen: string[] = [];
    const d = await draftResponse(
      fake([bad[0]!, cases[0]![2]], seen),
      bag,
      decision,
      [],
    );
    assert.equal(d.source, "llm");
    assert.equal(seen.length, 2);
    assert.match(
      JSON.parse(seen[1]!).messages.at(-1).content,
      /rejected because.*still lack/s,
    );
  });

  it("drops the flagged sentences and keeps the rest without asking again", async () => {
    const seen: string[] = [];
    const d = await draftResponse(
      fake(
        [
          "The charge was made through the buyer's PayPal account. We hold the order as it was placed. We have enclosed the documentation. We ask PayPal to find in our favour.",
        ],
        seen,
      ),
      bag,
      decision,
      [],
    );
    assert.equal(seen.length, 1);
    assert.equal(d.source, "llm");
    assert.doesNotMatch(d.response, /enclosed/);
    assert.match(d.response, /as it was placed\. We ask PayPal to find/);
  });

  it("cites an attached item by name and may then say it is enclosed", async () => {
    const added = [
      {
        item: "Prior orders from this buyer",
        note: "Hana Kobayashi has 1 other order with us on this PayPal account: Oct 14, 2026, $203.00.",
      },
    ];
    const seen: string[] = [];
    const text =
      "The buyer authorised this payment. We enclose the prior orders from this buyer on the same PayPal account. We ask PayPal to find in our favour.";
    const d = await draftResponse(
      fake([text], seen),
      hana,
      decision,
      [],
      undefined,
      added,
    );
    assert.equal(d.source, "llm");
    assert.match(d.response, /prior orders/i);
    assert.match(
      JSON.parse(
        JSON.parse(seen[0]!).messages.at(-1).content,
      ).facts_on_file.join("\n"),
      /Evidence on file: Prior orders from this buyer:/,
    );
    const off = await draftResponse(
      createLlm({ env: {} }),
      hana,
      decision,
      [],
      undefined,
      added,
    );
    assert.deepEqual(
      groundingProblems(
        off.response,
        buildChecklist(withAdded(hana, added)),
        "x",
      ),
      [],
    );
  });

  it("leaves orders that are disputes themselves out of the prior-orders evidence", () => {
    const prior = buildChecklist(hana).find(
      (i) => i.item === "Prior orders from this buyer",
    );
    assert.match(prior?.suggestion?.label ?? "", /1 other order$/);
    assert.ok(!prior?.suggestion?.note.includes("39.00"));
  });

  it("flags the contradiction markers on their own", () => {
    const cl = buildChecklist(priya);
    for (const t of bad) assert.ok(groundingProblems(t, cl, "").length > 0, t);
    assert.deepEqual(
      groundingProblems(
        "The two charges are for two separate orders, not one charge taken twice.",
        cl,
        "",
      ),
      [],
    );
  });

  const sofia = seeded({
    dispute_id: "PP-D-GIFTCARD-0001",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    buyer: "Sofia Lindqvist",
    amount_cents: 5000,
    purchased_at: "2026-11-02T10:00:00.000Z",
    items: [{ item_quantity: "1", item_description: "Gift card" }],
    messages: [msg("BUYER", "The gift card code never arrived.")],
  });
  const mixed = [
    "We are providing the item in evidence we still lack.",
    "There is no evidence on file.",
    "We have enclosed the available documentation.",
    "The buyer has proof that the two charges are related to the same transaction.",
    "We shipped it with UPS tracking 1Z999AA10123456784 on Oct 30.",
  ];
  const all: [string, CaseView, string][] = [
    ...cases,
    ["Sofia Lindqvist", sofia, GOOD],
  ];
  for (const [name, c, good] of all) {
    it(`${name}: a reply mixing good and bad sentences keeps only the good ones`, async () => {
      const [g1, ...gs] = sentencesOf(good);
      const seen: string[] = [];
      const text = [g1, ...mixed, ...gs].join(" ");
      const d = await draftResponse(fake([text], seen), c, decision, []);
      assert.equal(d.source, "llm");
      assert.equal(d.label, "AI draft");
      assert.equal(seen.length, 1);
      assert.ok(sentencesOf(d.response).length >= 3);
      assert.ok(sentencesOf(d.response).length <= 5);
      assert.deepEqual(
        groundingProblems(d.response, buildChecklist(c), ""),
        [],
      );
      assert.doesNotMatch(
        d.response,
        /lack|still need|enclosed|providing|same transaction|no evidence/i,
      );
    });

    it(`${name}: the template draft is grounded too`, async () => {
      const d = await draftResponse(createLlm({ env: {} }), c, decision, []);
      assert.equal(d.label, "Draft (AI unavailable)");
      assert.deepEqual(
        groundingProblems(d.response, buildChecklist(c), ""),
        [],
      );
      assert.doesNotMatch(
        d.response,
        /lack|enclosed|providing|same transaction/i,
      );
      if (c.reason === "UNAUTHORISED")
        assert.doesNotMatch(d.response, /authorised this payment/);
      if (c.dispute_id === "PP-D-1724441021")
        assert.doesNotMatch(d.response, /fulfilled/);
    });
  }

  describe("claims the file does not back", () => {
    const run = (
      c: CaseView,
      texts: string[],
      added?: { item: string; note: string }[],
    ) => draftResponse(fake(texts), c, decision, [], undefined, added);
    it("Priya, fight anyway: no admission, shipments or same cardholder", async () => {
      const d = await run(priya, [
        "Both transactions were authorized by the same cardholder within minutes of each other. The buyer has acknowledged receiving both items in separate shipments. The charge was made through the buyer's PayPal account. We hold the order as it was placed. We ask PayPal to find in our favour.",
      ]);
      assert.equal(d.source, "llm");
      assert.doesNotMatch(
        d.response,
        /acknowledged|separate shipments|same cardholder|within minutes|distinct purchases/i,
      );
      assert.notEqual(d.label, "Draft (AI unavailable)");
      assert.ok(sentencesOf(d.response).length >= 3);
    });
    it("drops 'our system shows' with nothing on file", async () => {
      const d = await run(bag, [
        "Our system shows the transaction completed successfully with no reported issues. The charge was made through the buyer's PayPal account. We hold the order as it was placed. We ask PayPal to find in our favour.",
      ]);
      assert.equal(d.source, "llm");
      assert.doesNotMatch(d.response, /our system|no reported issues/i);
    });
    it("Sofia before attach: 'as recorded in our system' is dropped", async () => {
      const d = await run(sofia, [
        "The code was sent to the buyer's email address, as recorded in our system. The charge was made through the buyer's PayPal account. We hold the order as it was placed. We ask PayPal to find in our favour.",
      ]);
      assert.equal(d.source, "llm");
      assert.doesNotMatch(d.response, /recorded/i);
    });
    it("Sofia after attach: updated label, and the text names the email log", async () => {
      const added = [
        {
          item: "Proof the code was sent (email log)",
          note: "The gift card code was emailed to the buyer's PayPal email address on Nov 2, 2026, the day of purchase.",
        },
      ];
      const d = await run(
        sofia,
        [
          "The gift card code was emailed to the buyer's PayPal email address on Nov 2, 2026, the day of purchase. We enclose the email log. We ask PayPal to find in our favour.",
        ],
        added,
      );
      assert.equal(d.source, "llm");
      assert.equal(d.label, "AI draft, updated with your evidence");
      assert.match(d.response, /email log/i);
    });
    it("tent: a clean reply is an AI draft (position text no longer needs a keyword)", async () => {
      const d = await run(tent, [
        `${positionFor(tent)} We hold the order as it was placed. We ask PayPal to find in our favour.`,
      ]);
      assert.equal(d.source, "llm");
      assert.equal(d.label, "AI draft");
      assert.ok(
        d.response.includes(
          "We ask PayPal to confirm that this order was paid only once",
        ),
      );
    });
    it("a reply that fails twice gives the grounded template, not 'unavailable'", async () => {
      const d = await run(bag, [bad[0]!]);
      assert.equal(d.source, "fallback");
      assert.equal(d.fallback_reason, "grounding");
      assert.equal(d.label, "Drafted from the case facts");
      const e = await run(
        bag,
        [bad[0]!],
        [{ item: "Photos of the item", note: "Photos on file." }],
      );
      assert.equal(e.label, "Drafted from your evidence");
    });
    it("a thrown or unreachable model is the unavailable template", async () => {
      const llm = createLlm({
        env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      });
      const d = await draftResponse(llm, bag, decision, []);
      assert.equal(d.label, "Draft (AI unavailable)");
      assert.equal(d.fallback_reason, "ai_down");
    });
    it("no seeded case's draft says lack, enclosed or providing without an item on file", async () => {
      for (const [, c] of all) {
        for (const t of bad) {
          const d = await draftResponse(fake([t]), c, decision, []);
          assert.doesNotMatch(d.response, /lack|enclosed|providing/i, t);
        }
        const off = await draftResponse(
          createLlm({ env: {} }),
          c,
          decision,
          [],
        );
        assert.doesNotMatch(off.response, /lack|enclosed|providing/i);
      }
    });
    it("unauthorised cases share one checklist policy", () => {
      for (const c of [hana, { ...hana, buyer_history: undefined }]) {
        const l = buildChecklist(c);
        assert.equal(l.find((i) => i.item.startsWith("Prior"))?.required, true);
        assert.equal(
          l.find((i) => i.item.startsWith("Shipping"))?.required,
          false,
        );
      }
    });
  });
});

describe("grounded, readable draft", () => {
  const note = (notes: string) => ({
    evidence_type: "OTHER",
    evidence_info: {},
    notes,
  });
  const marcus: CaseView = {
    ...base,
    reason: "UNAUTHORISED",
    buyer: "Marcus Bell",
    purchased_at: "2026-10-27T10:00:00Z",
    evidences: [
      note("Two tents and a pack shipped by UPS to the billing address"),
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: {
          tracking_info: [
            { carrier_name: "UPS", tracking_number: "1Z999AA10123456784" },
          ],
        },
      },
    ],
  };
  const dup: CaseView = {
    ...base,
    reason: "DUPLICATE_TRANSACTION",
    buyer: "Priya Nair",
    purchased_at: "2026-11-03T21:55:43Z",
  };

  it("asserts the position only when a backing checklist item is on file", () => {
    assert.equal(
      positionFor(dup),
      "We ask PayPal to review the two charges against the one order we have on file.",
    );
    const withOrder = withAdded(dup, [
      { item: "Order record", note: "Order record: two separate orders" },
    ]);
    assert.equal(
      positionFor(withOrder),
      "The two charges are for two separate orders, not one charge taken twice.",
    );
    assert.equal(
      positionFor(marcus),
      "We ask PayPal to review whether this payment was authorised.",
    );
    assert.equal(positionFor(withTracking), "The order was fulfilled.");
    assert.match(positionFor({ ...base, reason: "OTHER" }), /^We ask PayPal/);
    assert.match(
      positionFor({ ...base, reason: "PAYMENT_BY_OTHER_MEANS" }),
      /^We ask PayPal to confirm that this order was paid only once/,
    );
  });

  it("offers no refund item for a duplicate", () => {
    assert.ok(!buildChecklist(dup).some((i) => /refund/i.test(i.item)));
  });

  it("a billing address is not an address match", () => {
    const addr = (c: CaseView) =>
      buildChecklist(c).find((i) => i.item.startsWith("Shipping address"))!;
    assert.equal(addr(marcus).status, "missing");
    assert.equal(addr(marcus).suggestion, undefined);
    assert.equal(
      addr({
        ...marcus,
        evidences: [
          note("Shipping address matches the buyer's PayPal address"),
        ],
      }).status,
      "present",
    );
  });

  it("puts the order and the buyer's message in one 'On file' sentence and the evidence in an 'Our evidence' list", () => {
    const c = withAdded(marcus, [
      { item: "Photos of the item", note: "Photos on file" },
    ]);
    const r = fallbackDraft(c, decision).response;
    assert.ok(!/^Re:|facts below/.test(r));
    assert.match(
      r,
      /On file: the order of Oct 27, 2026 for 2 × Hardware kit #1234, USD 120\.00, and Marcus Bell's message of Nov 6, 2026\. Our evidence: Two tents and a pack shipped by UPS to the billing address, UPS tracking number 1Z999AA10123456784, and Photos of the item: Photos on file\./,
    );
    assert.doesNotMatch(r, /On file:[^.]*;/);
    assert.match(
      fallbackDraft(marcus, decision).response,
      /Our evidence: Two tents and a pack shipped by UPS to the billing address and UPS tracking number 1Z999AA10123456784\./,
    );
  });

  it("is 3 to 5 sentences and the untouched draft passes the send gate", async () => {
    const c = { ...marcus, buyer_open_disputes: 3 };
    for (const d of [
      fallbackDraft(c, decision),
      await draftResponse(createLlm({ env: {} }), c, decision, []),
    ]) {
      const n = sentencesOf(d.response).length;
      assert.ok(n >= 3 && n <= 5, d.response);
      assert.deepEqual(unsupportedClaims(d.response, proofText(c, [])), []);
    }
  });

  it("adds the buyer pattern at 3 open disputes and not at 2", () => {
    const at = (n: number) =>
      fallbackDraft({ ...marcus, buyer_open_disputes: n }, decision).response;
    assert.match(
      at(3),
      /Marcus Bell has 3 open disputes with us at the same time; we ask PayPal to take this pattern into account\./,
    );
    assert.doesNotMatch(at(2), /open disputes/);
  });

  it("keeps the model's three sentences and strips a Re: header", async () => {
    const llm = createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    response:
                      "Re: Ava Chen's claim about 2 × Hardware kit #1234 (USD 120.00). We ask PayPal to review whether the order was fulfilled as placed. The order was for 2 × Hardware kit #1234. We ask PayPal to find in our favour.",
                  }),
                },
              },
            ],
          }),
        ),
    });
    const d = await draftResponse(llm, base, decision, []);
    assert.equal(d.source, "llm");
    assert.doesNotMatch(d.response, /Re:/);
    assert.equal(sentencesOf(d.response).length, 3);
    assert.ok(d.response.endsWith("We ask PayPal to find in our favour."));
  });
});

describe("model drafting over the seeded cases", () => {
  const msg = (content: string) => ({
    posted_by: "BUYER" as const,
    time_posted: "2026-11-05T00:00:00Z",
    content,
  });
  const seeded = (o: Partial<CaseView>): CaseView => ({
    ...base,
    merchant: "Ikigai Outfitters",
    ...o,
  });
  const record = {
    item: "Proof the two charges are separate orders",
    note: "Order record: 1 × Alder Waterproof Hiking Boots, USD 164.00, placed Nov 3, 2026.",
  };
  const priya = seeded({
    dispute_id: "PP-D-DUPLICATE-0003",
    reason: "DUPLICATE_TRANSACTION",
    buyer: "Priya Nair",
    amount_cents: 16400,
    purchased_at: "2026-11-03T21:55:43.450Z",
    items: [
      { item_quantity: "1", item_description: "Alder Waterproof Hiking Boots" },
    ],
    messages: [
      msg(
        "I was charged twice for one pair of Alder boots. I only placed one order.",
      ),
    ],
  });
  const sofia = seeded({
    dispute_id: "PP-D-GIFTCARD-0001",
    buyer: "Sofia Lindqvist",
    amount_cents: 5000,
    purchased_at: "2026-11-02T10:00:00.000Z",
    items: [{ item_quantity: "1", item_description: "Gift card" }],
    messages: [msg("The gift card code never arrived.")],
  });
  const marcus = seeded({
    dispute_id: "PP-D-3237289029",
    reason: "OTHER",
    buyer: "Marcus Bell",
    amount_cents: 17900,
    purchased_at: "2026-10-17T05:03:00.282Z",
    items: [{ item_quantity: "1", item_description: "Ember 20F Sleeping Bag" }],
    messages: [
      msg("There is a problem with this payment and I need help resolving it."),
    ],
  });
  const hana = seeded({
    dispute_id: "PP-D-8916749540",
    reason: "UNAUTHORISED",
    buyer: "Hana Kobayashi",
    amount_cents: 16400,
    purchased_at: "2026-10-27T23:50:36.515Z",
    items: [
      { item_quantity: "1", item_description: "Alder Waterproof Hiking Boots" },
    ],
    messages: [msg("I did not authorise Alder Waterproof Hiking Boots.")],
  });
  const FORBIDDEN =
    /separate orders|two orders|buyer authori[sz]ed|order was fulfilled|matched its listing/i;
  const model = (reply: string) =>
    createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ response: reply }) } },
            ],
          }),
        ),
    });
  const lies =
    "The two charges are for two separate orders. The buyer authorised this payment. The order was fulfilled.";

  it("for the four seeded cases the draft is 3 to 5 sentences, names every evidence item and states no unbacked position", async () => {
    const rows: [CaseView, { item: string; note: string }[], string][] = [
      [priya, [record], "order record"],
      [
        sofia,
        [
          {
            item: "Proof the code was sent (email log)",
            note: "The gift card code was emailed on Nov 2, 2026.",
          },
        ],
        "email log",
      ],
      [
        marcus,
        [{ item: "Photos of the item", note: "Photos on file" }],
        "photos",
      ],
      [
        hana,
        [
          {
            item: "Prior orders from this buyer",
            note: "Hana Kobayashi has 1 other order with us.",
          },
        ],
        "prior orders",
      ],
    ];
    for (const [c, added, noun] of rows) {
      const reply = `${lies} We have the ${noun} for this order. We hold the order as it was placed. We ask PayPal to review the order on file.`;
      const d = await draftResponse(
        model(reply),
        c,
        decision,
        [],
        undefined,
        added,
      );
      assert.equal(d.source, "llm", `${c.buyer}: ${d.error}`);
      assert.equal(d.label, "AI draft, updated with your evidence");
      const n = sentencesOf(d.response).length;
      assert.ok(n >= 3 && n <= 5, d.response);
      assert.match(d.response, new RegExp(noun, "i"));
      const backed = positionFor(withAdded(c, added)) === positionOf(c.reason);
      if (!backed) assert.doesNotMatch(d.response, FORBIDDEN, c.buyer);
      assert.doesNotMatch(
        d.response,
        /separate orders/i,
        c.buyer === "Priya Nair" ? "one record" : c.buyer,
      );
    }
  });

  it("falls back to the template when the model leaves out an evidence item", async () => {
    const reply =
      "We ask PayPal to review the two charges. We hold the order as it was placed. We ask PayPal to find in our favour.";
    const d = await draftResponse(
      model(reply),
      priya,
      decision,
      [],
      undefined,
      [record],
    );
    assert.equal(d.source, "fallback");
    assert.equal(d.label, "Drafted from your evidence");
    assert.match(d.error ?? "", /evidence item/);
  });

  it("one order record does not unlock 'two separate orders'; two do", () => {
    const one = withAdded(priya, [record]);
    assert.equal(buildChecklist(one)[0]!.status, "missing");
    assert.match(positionFor(one), /^We ask PayPal to review the two charges/);
    const two = withAdded(priya, [
      record,
      {
        ...record,
        note: "Order record: 1 × Alder Waterproof Hiking Boots, USD 164.00, placed Nov 3, 2026, second charge.",
      },
    ]);
    assert.equal(buildChecklist(two)[0]!.status, "present");
    assert.match(positionFor(two), /two separate orders/);
    const note = withAdded(priya, [
      { item: record.item, note: "These are two separate orders." },
    ]);
    assert.equal(buildChecklist(note)[0]!.status, "present");
  });
});

describe("pre-draft pool", () => {
  const llmFailingFirst = () => {
    let n = 0;
    return createLlm({
      env: { LLM_BASE_URL: "http://x", LLM_API_KEY: "k", LLM_MODEL: "m1" },
      fetch: async () => {
        if (n++ === 0) throw new Error("timeout");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    response: fallbackDraft(base, decision).response,
                  }),
                },
              },
            ],
          }),
        );
      },
    });
  };
  const run = async (ids: string[], keepGoing: (d: Draft) => boolean) => {
    const cache = new DraftCache(llmFailingFirst());
    const got: Record<string, string> = {};
    await pool(ids, 2, async (id) => {
      const d = await cache.get({ ...base, dispute_id: id }, decision, [], {});
      got[id] = d.source;
      return keepGoing(d);
    });
    return got;
  };

  it("one slow call does not stop the remaining cases", async () => {
    const got = await run(["a", "b", "c", "d", "e"], stopAfterDown(2));
    assert.equal(Object.keys(got).length, 5);
    assert.equal(Object.values(got).filter((x) => x === "llm").length, 4);
  });

  it("stops after two drafts in a row found the gateway down", () => {
    const k = stopAfterDown(2);
    const down = { fallback_reason: "ai_down" } as Draft;
    assert.equal(k(down), true);
    assert.equal(k({ fallback_reason: "grounding" } as Draft), true);
    assert.equal(k(down), true);
    assert.equal(k(down), false);
  });
});
