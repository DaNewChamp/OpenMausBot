import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelWebPairingRequest,
  createWebPairingSecrets,
  registerWebPairingRequest,
  redeemWebPairingRequest,
  WebPairingQrSession,
} from "./web-pairing-session";
import { parseWebPairingLink } from "../../shared/web-pairing-link";
import { clearHubConnection, getHubDeviceToken } from "./web-client-session";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("web pairing browser session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearHubConnection();
  });

  it("mints a 128-bit request id and 256-bit redeem secret whose hash is the public commitment", async () => {
    const secrets = await createWebPairingSecrets();
    expect(secrets.requestId.length).toBeGreaterThanOrEqual(22);
    expect(Buffer.from(secrets.redeemSecret, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(secrets.challengeHash).toBe(sha256Hex(secrets.redeemSecret));
    expect(secrets.challengeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("registers at the hub, builds a public QR without the redeem secret, and hydrates the same paired session on redeem", async () => {
    const token = "omb_" + "d".repeat(43);
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/web-pairing/requests") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { challengeHash: string; requestId: string };
        expect(body.challengeHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(body)).not.toMatch(/redeemSecret/);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            status: "pending",
            expiresAt: Date.now() + 60_000,
            hubId: "hub-1",
            hubOrigin: "https://hub-vbot.posival.com",
          }),
        };
      }
      if (url.includes("/redeem")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ token, device: { id: "dev-web", name: "Web browser" } }),
        };
      }
      throw new Error(url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = new WebPairingQrSession();
    await session.start({ baseUrl: "https://hub-vbot.posival.com", deviceName: "Web browser" });
    expect(session.link).toBeTruthy();
    const parsed = parseWebPairingLink(session.link!);
    expect(parsed?.hubOrigin).toBe("https://hub-vbot.posival.com");
    expect(session.link).not.toContain(session.secrets!.redeemSecret);
    expect(JSON.stringify(parsed)).not.toContain("redeemSecret");

    const pending = await session.pollOnce();
    expect(pending).toBe("paired");
    expect(getHubDeviceToken()).toBe(token);
    session.dispose();
    expect(session.secrets).toBeNull();
  });

  it("treats 202 as pending, cancels with the redeem secret, and refresh invalidates the old request", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init?.method, body });
        if (url.endsWith("/api/web-pairing/requests") && init?.method === "POST") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              status: "pending",
              expiresAt: Date.now() + 60_000,
              hubId: "hub-1",
              hubOrigin: "https://hub-vbot.posival.com",
            }),
          };
        }
        if (url.includes("/redeem")) {
          return { ok: true, status: 202, json: async () => ({ status: "pending" }) };
        }
        if (init?.method === "DELETE") {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        throw new Error(url);
      }),
    );

    const session = new WebPairingQrSession();
    await session.start({ baseUrl: "https://hub-vbot.posival.com", deviceName: "Web browser" });
    const firstId = session.secrets!.requestId;
    const firstSecret = session.secrets!.redeemSecret;
    expect(await session.pollOnce()).toBe("pending");
    await session.refresh({ baseUrl: "https://hub-vbot.posival.com", deviceName: "Web browser" });
    expect(session.secrets!.requestId).not.toBe(firstId);
    expect(session.secrets!.redeemSecret).not.toBe(firstSecret);
    const cancel = calls.find((call) => call.method === "DELETE");
    expect(cancel?.body).toEqual({ redeemSecret: firstSecret });
    expect(cancel?.url).toContain(firstId);
    session.dispose();
  });

  it("stops polling at expiry and clears the secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (String(input).endsWith("/api/web-pairing/requests") && init?.method === "POST") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              status: "pending",
              expiresAt: Date.now() - 1,
              hubId: "hub-1",
              hubOrigin: "https://hub-vbot.posival.com",
            }),
          };
        }
        if (init?.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
        throw new Error("should not redeem after expiry");
      }),
    );
    const session = new WebPairingQrSession();
    await session.start({ baseUrl: "https://hub-vbot.posival.com", deviceName: "Web browser" });
    expect(await session.pollOnce()).toBe("expired");
    expect(session.secrets).toBeNull();
  });
});

describe("web pairing HTTP helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registerWebPairingRequest posts only public fields to the configured hub origin", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ status: "pending", expiresAt: 1, hubId: "h", hubOrigin: "https://hub.example" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await registerWebPairingRequest({
      baseUrl: "https://hub.example",
      requestId: randomBytes(16).toString("base64url"),
      challengeHash: "a".repeat(64),
      deviceName: "Browser",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://hub.example/api/web-pairing/requests");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty("redeemSecret");
  });

  it("exports cancel and redeem helpers used by the session", async () => {
    expect(typeof cancelWebPairingRequest).toBe("function");
    expect(typeof redeemWebPairingRequest).toBe("function");
  });
});
