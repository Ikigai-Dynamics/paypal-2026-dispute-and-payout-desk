import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlm, jsonText } from "@jeirslab/llm-client";

describe("llm-client", () => {
  it("runs the fallback offline", async () => {
    const llm = createLlm({ env: {} });
    assert.equal(llm.online, false);
    const r = await llm.complete(
      { messages: [{ role: "user", content: "hi" }] },
      () => "offline answer",
    );
    assert.equal(r.source, "fallback");
    assert.equal(r.label, "offline fallback");
    assert.ok(!/LLM_/.test(r.error ?? ""), "no env var names in output");
    assert.equal(r.value, "offline answer");
  });

  it("calls an OpenAI-compatible endpoint and never leaks the key on failure", async () => {
    const env = {
      LLM_BASE_URL: "http://llm.invalid/v1",
      LLM_API_KEY: "fake-test-key",
      LLM_MODEL: "m",
    };
    let seen: { url: string; auth: string; body: any } | undefined;
    const ok = createLlm({
      env,
      fetch: (async (u: string, init: any) => {
        seen = {
          url: u,
          auth: init.headers.authorization,
          body: JSON.parse(init.body),
        };
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }),
          { status: 200 },
        );
      }) as never,
    });
    const r = await ok.complete<{ a: number }>(
      { messages: [{ role: "user", content: "x" }], json: true },
      () => ({ a: 0 }),
    );
    assert.deepEqual(r.value, { a: 1 });
    assert.equal(r.source, "llm");
    assert.equal(seen?.url, "http://llm.invalid/v1/chat/completions");
    assert.equal(seen?.body.response_format.type, "json_object");

    const bad = createLlm({
      env,
      fetch: (async () => new Response("no", { status: 500 })) as never,
    });
    const f = await bad.complete(
      { messages: [{ role: "user", content: "x" }] },
      () => "fb",
    );
    assert.equal(f.source, "fallback");
    assert.ok(!JSON.stringify(f).includes("fake-test-key"));

    const garbled = createLlm({
      env,
      fetch: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
        )) as never,
    });
    assert.equal(
      (await garbled.complete({ messages: [], json: true }, () => 1)).source,
      "fallback",
    );
  });

  it("prices each call and keeps a running total", async () => {
    const env = {
      LLM_BASE_URL: "http://x/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
    };
    const reply = (usage?: object) =>
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "abcdefgh" } }],
            ...(usage && { usage }),
          }),
          { status: 200 },
        )) as never;
    const real = createLlm({
      env,
      fetch: reply({ prompt_tokens: 1000, completion_tokens: 100 }),
    });
    const r = await real.complete(
      { messages: [{ role: "user", content: "hi" }] },
      () => "",
    );
    // openai/gpt-5: $1.25 in, $10 out per million
    assert.deepEqual(r.usage, {
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 0.00225,
      pricedAs: "openai/gpt-5",
      estimated: false,
    });
    await real.complete(
      { messages: [{ role: "user", content: "hi" }] },
      () => "",
    );
    assert.equal(real.spend().calls, 2);
    assert.ok(Math.abs(real.spend().costUsd - 0.0045) < 1e-12);

    const est = createLlm({
      env: { ...env, LLM_PRICE_AS: "openai/gpt-5-mini" },
      fetch: reply(),
    });
    const e = await est.complete(
      { messages: [{ role: "user", content: "12345678" }] },
      () => "",
    );
    assert.equal(e.usage?.estimated, true);
    assert.equal(e.usage?.inputTokens, 2);
    assert.equal(e.usage?.outputTokens, 2);
    assert.equal(e.usage?.pricedAs, "openai/gpt-5-mini");

    const off = createLlm({ env: {} });
    const f = await off.complete(
      { messages: [{ role: "user", content: "hi" }] },
      () => "x",
    );
    assert.equal(f.usage, undefined);
    assert.equal(off.spend().costUsd, 0);
  });

  it("reads JSON wrapped in a code fence or prose", () => {
    assert.equal(jsonText('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(jsonText('Here you go: {"a":{"b":2}} done'), '{"a":{"b":2}}');
    assert.equal(jsonText('{"a":1}'), '{"a":1}');
  });
});
