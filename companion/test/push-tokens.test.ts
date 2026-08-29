import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { apnsConfigured, maybeSendApns, savePushToken } from "../src/push-tokens.ts";
import { DATA_DIR } from "../src/state.ts";

describe("companion push tokens", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    delete process.env.OMB_APNS_KEY_P8;
    delete process.env.OMB_APNS_KEY_ID;
    delete process.env.OMB_APNS_TEAM_ID;
  });

  it("stores a device token under the companion data dir", () => {
    savePushToken("dev-1", "token-abc");
    const stored = JSON.parse(readFileSync(join(DATA_DIR, "push-tokens.json"), "utf8"));
    expect(stored["dev-1"]).toBe("token-abc");
  });

  it("does not claim APNs delivery without Apple credentials", () => {
    expect(apnsConfigured()).toBe(false);
    expect(maybeSendApns({ deviceToken: "abc", title: "Needs you" })).toEqual({
      sent: false,
      reason: "APNs credentials are not configured on this hub",
    });
  });

  it("still no-ops when credentials exist because the MacBook/iPhone lane signs the relay", () => {
    process.env.OMB_APNS_KEY_P8 = "fake";
    process.env.OMB_APNS_KEY_ID = "KEYID";
    process.env.OMB_APNS_TEAM_ID = "TEAMID";
    expect(apnsConfigured()).toBe(true);
    expect(maybeSendApns({ deviceToken: "abc", title: "Needs you" }).sent).toBe(false);
  });
});
