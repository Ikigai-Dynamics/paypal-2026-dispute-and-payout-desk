import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createValkey, makeValkey } from "@jeirslab/valkey-client";

describe("valkey-client", () => {
  it("returns undefined without VALKEY_SENTINELS or VALKEY_URL", () => {
    assert.equal(createValkey({}), undefined);
  });
  it("builds a client without connecting eagerly to a dead address, and survives error events", () => {
    const v = makeValkey({ VALKEY_URL: "redis://127.0.0.1:1" });
    v.emit("error", new Error("boom")); // the handler swallows it
    v.disconnect();
    const s = createValkey({
      VALKEY_SENTINELS: "127.0.0.1:1",
      VALKEY_MASTER_NAME: "m",
    });
    assert.ok(s);
    s.disconnect();
  });
});
