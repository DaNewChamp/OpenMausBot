import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  assertHubApiReady,
  canCallHubApi,
  classifyPairFailure,
  clearHubConnection,
  createPairRequestId,
  defaultWebHubUrl,
  hubAttachmentUrl,
  HubPairError,
  isPairRequestId,
  normalizeHubBaseUrl,
  pairDirectHub,
  setHubApiBase,
  setHubDeviceToken,
} from "./web-client-session";

describe("web client session gates", () => {
  beforeEach(() => {
    setHubApiBase("");
    setHubDeviceToken(null);
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
});

describe("pair request ids", () => {
  it("generates ids the hub will accept", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = createPairRequestId();
      expect(id).toHaveLength(32);
      expect(isPairRequestId(id)).toBe(true);
    }
  });

  it("clamps requested lengths into the hub's accepted range", () => {
    expect(createPairRequestId(4)).toHaveLength(16);
    expect(createPairRequestId(9999)).toHaveLength(128);
    expect(isPairRequestId(createPairRequestId(4))).toBe(true);
    expect(isPairRequestId(createPairRequestId(9999))).toBe(true);
  });

  it("rejects ids outside the hub's pattern", () => {
    expect(isPairRequestId("tooshort")).toBe(false);
    expect(isPairRequestId("has spaces in it here")).toBe(false);
    expect(isPairRequestId("has/slashes/in/it/here")).toBe(false);
  });
});

describe("pair failure classification", () => {
  it("separates a retypeable code from a dead pairing window", () => {
    expect(classifyPairFailure("that pairing credential is not right")).toBe("wrong-code");
    expect(classifyPairFailure("no pairing is in progress — open Phone settings on your computer")).toBe(
      "window-closed",
    );
    expect(classifyPairFailure("too many incorrect codes — start pairing again")).toBe("window-closed");
    expect(classifyPairFailure("too many paired devices — remove one first")).toBe("device-limit");
    expect(classifyPairFailure("could not save the pairing: disk full")).toBe("save-failed");
    expect(classifyPairFailure("something nobody wrote")).toBe("unknown");
  });
});

describe("pairDirectHub", () => {
  beforeEach(() => {
    setHubApiBase("");
    setHubDeviceToken(null);
  });

  it("surfaces the hub's own sentence verbatim and classifies it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "too many paired devices — remove one first" }),
      }),
    );
    const failure = await pairDirectHub({
      baseUrl: "https://hub.example",
      credential: "code",
      deviceName: "Web browser",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HubPairError);
    expect((failure as HubPairError).message).toBe("too many paired devices — remove one first");
    expect((failure as HubPairError).fromHub).toBe(true);
    expect((failure as HubPairError).kind).toBe("device-limit");
    vi.unstubAllGlobals();
  });

  it("falls back to generic wording when the hub said nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const failure = (await pairDirectHub({
      baseUrl: "https://hub.example",
      credential: "code",
      deviceName: "Web browser",
    }).catch((error: unknown) => error)) as HubPairError;
    expect(failure.fromHub).toBe(false);
    expect(failure.kind).toBe("unknown");
    vi.unstubAllGlobals();
  });

  it("sends a valid pairRequestId and drops a malformed one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "omb_" + "a".repeat(43), device: { id: "d1", name: "Web browser" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const good = createPairRequestId();
    await pairDirectHub({
      baseUrl: "https://hub.example",
      credential: "code",
      deviceName: "Web browser",
      pairRequestId: good,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).pairRequestId).toBe(good);

    await pairDirectHub({
      baseUrl: "https://hub.example",
      credential: "code",
      deviceName: "Web browser",
      pairRequestId: "bad id",
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).pairRequestId).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("keeps the whole device record from a successful pairing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "omb_" + "a".repeat(43),
          device: {
            id: "dev-1",
            name: "Vincent's browser",
            createdAt: 1,
            lastSeenAt: 2,
            cloudDesktopAccess: true,
            localVmAccess: false,
          },
        }),
      }),
    );
    const connection = await pairDirectHub({
      baseUrl: "https://hub.example",
      credential: "code",
      deviceName: "Web browser",
    });
    expect(connection.deviceName).toBe("Vincent's browser");
    expect(connection.device).toMatchObject({ id: "dev-1", cloudDesktopAccess: true, localVmAccess: false });
    vi.unstubAllGlobals();
  });

  it("reports an unreachable hub instead of throwing a raw network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const failure = (await pairDirectHub({
      baseUrl: "https://hub.example",
      credential: "code",
      deviceName: "Web browser",
    }).catch((error: unknown) => error)) as HubPairError;
    expect(failure).toBeInstanceOf(HubPairError);
    expect(failure.message).toMatch(/could not reach that hub/i);
    vi.unstubAllGlobals();
  });
});

describe("hubAttachmentUrl", () => {
  beforeEach(() => setHubApiBase("https://hub-vbot.posival.com"));

  it("re-hangs a hub-relative avatar off the paired hub origin", () => {
    expect(hubAttachmentUrl("/api/attachments/abc123.png")).toBe(
      "https://hub-vbot.posival.com/api/attachments/abc123.png",
    );
    expect(hubAttachmentUrl("abc123.jpeg")).toBe("https://hub-vbot.posival.com/api/attachments/abc123.jpeg");
  });

  it("refuses anything that is not a plain attachment filename", () => {
    expect(hubAttachmentUrl(null)).toBeNull();
    expect(hubAttachmentUrl("")).toBeNull();
    expect(hubAttachmentUrl("https://evil.example/x.png")).toBe(
      "https://hub-vbot.posival.com/api/attachments/x.png",
    );
    expect(hubAttachmentUrl("payload.svg")).toBeNull();
    expect(hubAttachmentUrl("script.js")).toBeNull();
  });
});
