import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm } from "@jeirslab/llm-client";
import {
  buildChecklist,
  draftResponse,
  fallbackDraft,
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
        d.response.includes("120.00 USD") &&
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

  it("explanation is the decision terms, and says so when there is no decision", () => {
    assert.equal(
      fallbackDraft(base, decision).explanation,
      "term one term two",
    );
    assert.match(fallbackDraft(base, null).explanation, /unreachable/);
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
    assert.equal(items("OTHER").length, 2);
  });
});

describe("draftResponse", () => {
  it("uses the fallback offline and labels it", async () => {
    const d = await draftResponse(createLlm({ env: {} }), base, decision, []);
    assert.equal(d.source, "fallback");
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
    assert.deepEqual([d.source, d.model, d.response], ["llm", "m1", "R"]);
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
