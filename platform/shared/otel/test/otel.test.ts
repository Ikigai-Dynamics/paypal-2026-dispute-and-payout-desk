import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startTracing, withSpan } from "@jeirslab/otel";

describe("otel", () => {
  it("is a no-op without an endpoint", async () => {
    const h = await startTracing({});
    assert.equal(h.enabled, false);
    await h.shutdown();
  });

  it("is a no-op when disabled", async () => {
    const h = await startTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_SDK_DISABLED: "true",
    });
    assert.equal(h.enabled, false);
  });

  it("withSpan returns the value and rethrows errors", async () => {
    assert.equal(await withSpan("ok", () => 7), 7);
    await assert.rejects(
      withSpan("bad", () => {
        throw new Error("boom");
      }),
      /boom/,
    );
  });
});
