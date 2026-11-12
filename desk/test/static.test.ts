import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { staticAsset } from "../src/static.js";

describe("static image route", () => {
  it("serves landing art and favicons", () => {
    assert.equal(staticAsset("/img/hero.png"), "img/hero.png");
    assert.equal(staticAsset("/favicon.ico"), "favicon.ico");
    assert.equal(staticAsset("/apple-touch-icon.png"), "apple-touch-icon.png");
  });
  it("refuses traversal and anything else", () => {
    for (const p of [
      "/img/../server.js",
      "/img/..%2f..%2fserver.js",
      "/img/%2e%2e/x.png",
      "/img/a/b.png",
      "/img/hero.svg",
      "/../etc/passwd",
      "/index.html",
    ])
      assert.equal(staticAsset(p), null, p);
  });
});
