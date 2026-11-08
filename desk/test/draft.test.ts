import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm } from "@jeirslab/llm-client";
import {
  buildChecklist,
  explanationOf,
  draftResponse,
  fallbackDraft,
  invalidReason,
  isDraftShape,
} from "../src/draft.js";
import type { CaseView, Decision } from "../src/types.js";

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
    assert.ok(d.response.includes("UPS 1Z999AA10123456784"));
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

  it("opens with the merchant and buyer, never the dispute id or a reason", () => {
    const r = fallbackDraft(base, decision).response;
    assert.ok(
      r.startsWith(
        "Re: Ava Chen's claim about 2 × Hardware kit #1234 (USD 120.00).",
      ),
    );
    assert.ok(!/PP-D-|not received|NOT_RECEIVED/.test(r));
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
    assert.equal(invalidReason(r, r), null);
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
      "Attach order history: 1 earlier order",
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
      "Refund issued for the duplicate",
    ]);
    assert.deepEqual(items("CREDIT_NOT_PROCESSED"), [
      "Return received record",
      "Refund issued",
    ]);
    assert.equal(items("OTHER").length, 2);
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

describe("draftResponse", () => {
  it("uses the fallback offline and labels it", async () => {
    const d = await draftResponse(createLlm({ env: {} }), base, decision, []);
    assert.equal(d.source, "fallback");
    assert.equal(d.label, "offline fallback");
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
                    response: "R",
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
      ["llm", "m1", "R", "AI (m1)"],
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
                    response: "R",
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
