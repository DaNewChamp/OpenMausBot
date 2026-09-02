import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  accountDiscoveryOnly,
  assertHubApiReady,
  canCallHubApi,
  clearHubConnection,
  consumeAccountTokenFromLocation,
  normalizeHubBaseUrl,
  pocketIdCallbackURL,
  setHubApiBase,
  setHubDeviceToken,
} from "./web-client-session";

describe("web client session gates", () => {
  beforeEach(() => {
    setHubApiBase("");
    setHubDeviceToken(null);
  });

  it("allows account discovery routes only before hub pairing", () => {
    expect(accountDiscoveryOnly("/v1/fleet", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/v1/me", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/api/auth/sign-in/email-otp", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/api/bots", "?client=web")).toBe(false);
    expect(accountDiscoveryOnly("/v1/fleet", "")).toBe(false);
  });

  it("requires a paired hub token before hub API calls", () => {
    setHubApiBase("https://hub.example");
    setHubDeviceToken("omb_" + "a".repeat(43));
    expect(canCallHubApi()).toBe(true);
    assertHubApiReady();
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
    expect(() => assertHubApiReady()).toThrow(/pairing/i);
  });

  it("rejects malformed hub base URLs", () => {
    expect(normalizeHubBaseUrl("https://user:pass@hub.example")).toBeNull();
    expect(normalizeHubBaseUrl("https://hub.example")).toBe("https://hub.example");
  });

  it("routes PocketID through the control-plane completion bridge", () => {
    const callback = pocketIdCallbackURL(
      "https://accounts.openmausbot.com",
      "https://app.openmausbot.com/?client=web",
    );
    expect(callback).toBe(
      "https://accounts.openmausbot.com/web-client/complete?redirect=" +
        encodeURIComponent("https://app.openmausbot.com/?client=web"),
    );
  });

  it("consumes account tokens from the location hash once", () => {
    const token = "signed." + "a".repeat(40);
    const replaceState = vi.fn();
    const location = {
      hash: `#account=${encodeURIComponent(token)}`,
      pathname: "/",
      search: "?client=web",
    };
    vi.stubGlobal("location", location);
    vi.stubGlobal("history", { replaceState });
    expect(consumeAccountTokenFromLocation()).toBe(token);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?client=web");
    location.hash = "";
    expect(consumeAccountTokenFromLocation()).toBeNull();
    vi.unstubAllGlobals();
  });
});
