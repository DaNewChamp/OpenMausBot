import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  accountDiscoveryOnly,
  assertAccountDiscoveryOnly,
  assertHubApiReady,
  bootstrapWebClientAuth,
  canCallHubApi,
  clearAccountSession,
  clearHubConnection,
  consumeWebAuthCodeFromLocation,
  exchangeWebAuthCode,
  normalizeHubBaseUrl,
  persistAccountSession,
  pocketIdCallbackURL,
  resolveControlPlaneUrl,
  setAccountToken,
  setHubApiBase,
  setHubDeviceToken,
} from "./web-client-session";

describe("web client session gates", () => {
  beforeEach(() => {
    setHubApiBase("");
    setHubDeviceToken(null);
    clearAccountSession();
  });

  it("allows account discovery routes only before hub pairing", () => {
    expect(accountDiscoveryOnly("/v1/fleet", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/v1/me", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/api/auth/sign-in/email-otp", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/web-client/exchange", "?client=web")).toBe(true);
    expect(accountDiscoveryOnly("/api/bots", "?client=web")).toBe(false);
    expect(accountDiscoveryOnly("/v1/fleet", "")).toBe(false);
  });

  it("throws when web mode hits a hub route without pairing", () => {
    expect(() => assertAccountDiscoveryOnly("/api/bots", "?client=web")).toThrow(/pairing/i);
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

  it("allows only the default control plane or explicit loopback dev overrides", () => {
    expect(resolveControlPlaneUrl("?client=web&controlPlane=https://evil.example")).toBe(
      "https://accounts.openmausbot.com",
    );
    expect(resolveControlPlaneUrl("?client=web&controlPlane=http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
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

  it("consumes one-time auth codes from the query string once", () => {
    const replaceState = vi.fn();
    const location = {
      pathname: "/",
      search: "?client=web&web_auth_code=abc123",
    };
    vi.stubGlobal("location", location);
    vi.stubGlobal("history", { replaceState });
    expect(consumeWebAuthCodeFromLocation()).toBe("abc123");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?client=web");
    location.search = "?client=web";
    expect(consumeWebAuthCodeFromLocation()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("stores account tokens in memory only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accountToken: "signed." + "a".repeat(40) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = await exchangeWebAuthCode("https://accounts.openmausbot.com", "exchange-code");
    expect(token.startsWith("signed.")).toBe(true);
    persistAccountSession(token);
    setAccountToken(null);
    clearAccountSession();
    vi.unstubAllGlobals();
  });

  it("bootstraps account auth when a web auth code is present", async () => {
    vi.stubGlobal("location", { search: "?client=web&web_auth_code=code123", pathname: "/" });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ accountToken: "signed." + "b".repeat(40) }),
      }),
    );
    const token = await bootstrapWebClientAuth("https://accounts.openmausbot.com");
    expect(token?.startsWith("signed.")).toBe(true);
    vi.unstubAllGlobals();
  });
});
