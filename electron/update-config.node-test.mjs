import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolvePrivateUpdateFeed } from "./update-config.mjs";

describe("private V Bot update feed", () => {
  it("stays disabled when no explicit channel is configured", () => {
    assert.deepEqual(resolvePrivateUpdateFeed({}), {
      enabled: false,
      reason: "not-configured",
      message: "Private V Bot updates are disabled until an update channel is configured.",
    });
  });

  it("accepts only an explicit HTTPS feed without credentials or query data", () => {
    assert.deepEqual(resolvePrivateUpdateFeed({ VBOT_UPDATE_FEED_URL: "https://updates.example.test/vbot" }), {
      enabled: true,
      url: "https://updates.example.test/vbot/",
    });
    assert.equal(resolvePrivateUpdateFeed({ VBOT_UPDATE_FEED_URL: "http://updates.example.test/vbot" }).enabled, false);
    assert.equal(resolvePrivateUpdateFeed({ VBOT_UPDATE_FEED_URL: "https://user:secret@updates.example.test/vbot" }).enabled, false);
    assert.equal(resolvePrivateUpdateFeed({ VBOT_UPDATE_FEED_URL: "https://updates.example.test/vbot?channel=stable" }).enabled, false);
    assert.equal(resolvePrivateUpdateFeed({ VBOT_UPDATE_FEED_URL: "https://updates.example.test" }).url, "https://updates.example.test/");
  });
});
