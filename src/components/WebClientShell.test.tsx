import { describe, expect, it } from "vitest";

import { WebClientGate } from "./WebClientShell";
import {
  assertHubApiReady,
  canCallHubApi,
  clearHubConnection,
  setHubApiBase,
  setHubDeviceToken,
} from "@/lib/web-client-session";

const NAV_LABELS = ["Conversations", "Bots", "Fleet", "Settings", "Approvals"] as const;

describe("WebClientShell", () => {
  it("describes the gate and blocks hub API access before pairing", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
    expect(WebClientGate.name).toBe("WebClientGate");
    expect(() => assertHubApiReady()).toThrow(/pairing/i);
  });

  it("defines the five paired-shell navigation areas", () => {
    expect(NAV_LABELS).toEqual([
      "Conversations",
      "Bots",
      "Fleet",
      "Settings",
      "Approvals",
    ]);
  });

  it("requires hub pairing before connector preload can run", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
  });

  it("allows hub API access only after pairing credentials are in memory", () => {
    setHubApiBase("https://hub.example");
    setHubDeviceToken("omb_" + "c".repeat(43));
    expect(canCallHubApi()).toBe(true);
    clearHubConnection();
  });
});
