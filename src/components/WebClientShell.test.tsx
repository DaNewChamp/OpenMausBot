import { describe, expect, it } from "vitest";

import { WebClientGate } from "./WebClientShell";
import { WEB_CLIENT_NAV_ITEMS, webClientLayout } from "@/lib/web-client-layout";
import {
  assertHubApiReady,
  canCallHubApi,
  clearHubConnection,
  setHubApiBase,
  setHubDeviceToken,
} from "@/lib/web-client-session";

describe("WebClientShell", () => {
  it("describes the gate and blocks hub API access before pairing", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
    expect(WebClientGate.name).toBe("WebClientGate");
    expect(() => assertHubApiReady()).toThrow(/pairing/i);
  });

  it("defines the compact Grok desktop chrome instead of section navigation", () => {
    expect(WEB_CLIENT_NAV_ITEMS).toEqual(["Bots", "Rooms", "Find", "Account"]);
    expect(webClientLayout()).toEqual({
      leftRail: "bots",
      main: "conversation",
      rightPane: "on-demand",
      trafficLights: false,
    });
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
