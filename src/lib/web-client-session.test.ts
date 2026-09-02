import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  accountDiscoveryOnly,
  assertAccountDiscoveryOnly,
  assertHubApiReady,
  canCallHubApi,
  clearAccountSession,
  clearHubConnection,
  completeWebAuthHandoff,
  createWebControlPlaneClient,
  defaultWebHubUrl,
  exchangeWebAuthCode,
  isWebAuthHandoffMessage,
  normalizeHubBaseUrl,
  persistAccountSession,
  pocketIdCallbackURL,
  resolveControlPlaneUrl,
  setAccountToken,
  setHubApiBase,
  setHubDeviceToken,
  waitForWebAuthHandoff,
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
    expect(() => assertAccountDiscoveryOnly("/api/bots", "?client=web")).toThrow(/hub_pairing_required|pairing/i);
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

  it("defaults the branded web client to the branded hosted hub", () => {
    expect(defaultWebHubUrl("vbot.posival.com")).toBe("https://hub-vbot.posival.com");
    expect(defaultWebHubUrl("localhost")).toBe("");
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
    expect(callback).not.toContain("web_auth_code");
  });

  it("accepts postMessage handoffs only from the control plane origin", () => {
    const controlPlane = "https://accounts.openmausbot.com";
    expect(
      isWebAuthHandoffMessage(
        { type: "omb_web_auth_code", code: "a".repeat(43) },
        controlPlane,
        controlPlane,
      ),
    ).toBe(true);
    expect(
      isWebAuthHandoffMessage(
        { type: "omb_web_auth_code", code: "a".repeat(43) },
        "https://evil.example",
        controlPlane,
      ),
    ).toBe(false);
    expect(isWebAuthHandoffMessage({ type: "other", code: "a".repeat(43) }, controlPlane, controlPlane)).toBe(false);
  });

  it("waits for a strict-origin postMessage handoff", async () => {
    const handlers: Array<(event: MessageEvent) => void> = [];
    vi.stubGlobal("location", { origin: "https://app.openmausbot.com", search: "?client=web" });
    vi.stubGlobal("addEventListener", (type: string, handler: EventListenerOrEventListenerObject) => {
      if (type === "message" && typeof handler === "function") {
        handlers.push(handler as (event: MessageEvent) => void);
      }
    });
    vi.stubGlobal("removeEventListener", () => {});
    const pending = waitForWebAuthHandoff(
      "https://accounts.openmausbot.com",
      "https://app.openmausbot.com",
      5_000,
    );
    expect(handlers).toHaveLength(1);
    handlers[0]!(
      new MessageEvent("message", {
        origin: "https://accounts.openmausbot.com",
        data: { type: "omb_web_auth_code", code: "b".repeat(43) },
      }),
    );
    await expect(pending).resolves.toBe("b".repeat(43));
    vi.unstubAllGlobals();
  });

  it("rejects postMessage handoffs from unexpected origins", async () => {
    vi.useFakeTimers();
    const listeners: Array<(event: MessageEvent) => void> = [];
    vi.stubGlobal("location", { origin: "https://app.openmausbot.com", search: "?client=web" });
    vi.stubGlobal("addEventListener", (type: string, handler: (event: MessageEvent) => void) => {
      if (type === "message") listeners.push(handler);
    });
    vi.stubGlobal("removeEventListener", (type: string, handler: (event: MessageEvent) => void) => {
      if (type !== "message") return;
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    });
    const pending = waitForWebAuthHandoff(
      "https://accounts.openmausbot.com",
      "https://app.openmausbot.com",
      50,
    );
    for (const listener of listeners) {
      listener(
        new MessageEvent("message", {
          origin: "https://evil.example",
          data: { type: "omb_web_auth_code", code: "b".repeat(43) },
        }),
      );
    }
    const rejection = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stores account tokens in memory only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accountToken: "signed." + "a".repeat(40) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = await exchangeWebAuthCode("https://accounts.openmausbot.com", "c".repeat(43));
    expect(token.startsWith("signed.")).toBe(true);
    persistAccountSession(token);
    setAccountToken(null);
    clearAccountSession();
    vi.unstubAllGlobals();
  });

  it("exchanges postMessage handoff codes without using URL query params", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ accountToken: "signed." + "d".repeat(40) }),
      }),
    );
    const token = await completeWebAuthHandoff("https://accounts.openmausbot.com", "e".repeat(43));
    expect(token.startsWith("signed.")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("blocks non-discovery control-plane fetches at the client boundary", async () => {
    vi.stubGlobal("location", { origin: "https://app.openmausbot.com", search: "?client=web" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        user: { id: "user-1", email: "test@example.com", name: null, emailVerified: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createWebControlPlaneClient("https://accounts.openmausbot.com");
    await expect(client.me("signed." + "a".repeat(40))).resolves.toMatchObject({ email: "test@example.com" });
    await expect(client.listInstallations("signed." + "a".repeat(40))).rejects.toMatchObject({
      code: "hub_pairing_required",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
