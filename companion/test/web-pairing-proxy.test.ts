import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry, DEVICE_TOKEN_PATTERN } from "../src/devices.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { WebPairingRegistry } from "../../server/web-pairing-requests.ts";
import { serializeWebPairingLink } from "../../shared/web-pairing-link.ts";

const WEB_ORIGIN = "https://vbot.posival.com";
const OTHER_ORIGIN = "https://evil.example";
const HUB_ID = "hub-web-pair-1";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secrets() {
  const requestId = randomBytes(16).toString("base64url");
  const redeemSecret = randomBytes(32).toString("base64url");
  return { requestId, redeemSecret, challengeHash: sha256Hex(redeemSecret) };
}

async function startHub() {
  const devices = new DeviceRegistry();
  const webPairing = new WebPairingRegistry();
  const owner = devices.mintDevice("Owner iPhone");
  if ("error" in owner) throw new Error(owner.error);
  const proxy = createServer(
    createProxyHandler({
      harnessPort: 8799,
      authenticate: (token) => devices.authenticate(token),
      redeem: (credential, deviceName, pairRequestId) => devices.redeem(credential, deviceName, pairRequestId),
      serverName: () => "Test Hub",
      webClientOrigins: new Set([WEB_ORIGIN]),
      webPairing: {
        hubId: () => HUB_ID,
        hubOrigin: (req) => {
          const host = req.headers.host;
          return host ? `http://${host}` : null;
        },
        registry: webPairing,
        mintDevice: (name) => devices.mintDevice(name),
      },
    }),
  );
  const port = await listen(proxy);
  const hubOrigin = `http://127.0.0.1:${port}`;
  return { proxy, devices, webPairing, owner, hubOrigin, port };
}

describe("web pairing through the companion proxy", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("registers only from the configured origin, returns pending, and never echoes secrets", async () => {
    const { proxy, hubOrigin } = await startHub();
    const { requestId, redeemSecret, challengeHash } = secrets();
    try {
      const missingOrigin = await fetch(`${hubOrigin}/api/web-pairing/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, challengeHash, deviceName: "Browser" }),
      });
      expect(missingOrigin.status).toBe(403);

      const evil = await fetch(`${hubOrigin}/api/web-pairing/requests`, {
        method: "POST",
        headers: { origin: OTHER_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ requestId, challengeHash, deviceName: "Browser" }),
      });
      expect(evil.status).toBe(403);

      const created = await fetch(`${hubOrigin}/api/web-pairing/requests`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ requestId, challengeHash, deviceName: "Vincent's browser", redeemSecret }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
      const body = (await created.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: "pending", hubId: HUB_ID, hubOrigin });
      expect(JSON.stringify(body)).not.toContain(redeemSecret);
      expect(JSON.stringify(body)).not.toContain(challengeHash);
      expect(body.token).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("allows CORS preflight for register/redeem/cancel but not for phone approval", async () => {
    const { proxy, hubOrigin } = await startHub();
    const id = "a".repeat(22);
    try {
      const registerPreflight = await fetch(`${hubOrigin}/api/web-pairing/requests`, {
        method: "OPTIONS",
        headers: {
          origin: WEB_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(registerPreflight.status).toBe(204);

      const redeemPreflight = await fetch(`${hubOrigin}/api/web-pairing/requests/${id}/redeem`, {
        method: "OPTIONS",
        headers: {
          origin: WEB_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(redeemPreflight.status).toBe(204);

      const cancelPreflight = await fetch(`${hubOrigin}/api/web-pairing/requests/${id}`, {
        method: "OPTIONS",
        headers: {
          origin: WEB_ORIGIN,
          "access-control-request-method": "DELETE",
          "access-control-request-headers": "content-type",
        },
      });
      expect(cancelPreflight.status).toBe(204);

      const approvePreflight = await fetch(`${hubOrigin}/api/web-pairing/requests/${id}/approve`, {
        method: "OPTIONS",
        headers: {
          origin: WEB_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });
      expect(approvePreflight.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("runs pending → phone approve → browser redeem and keeps the old /api/pair path working", async () => {
    const { proxy, hubOrigin, owner, devices } = await startHub();
    const { requestId, redeemSecret, challengeHash } = secrets();
    const pairRequestId = randomBytes(16).toString("base64url");
    try {
      const created = await fetch(`${hubOrigin}/api/web-pairing/requests`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ requestId, challengeHash, deviceName: "Vincent's browser" }),
      });
      const pending = (await created.json()) as { expiresAt: number; hubId: string; hubOrigin: string };
      const link = serializeWebPairingLink({
        version: 1,
        hubOrigin: pending.hubOrigin,
        hubId: pending.hubId,
        requestId,
        challengeHash,
        deviceName: "Vincent's browser",
        expiresAt: pending.expiresAt,
      });
      expect(link).toContain("openmausbot://web-pair");
      expect(link).not.toContain(redeemSecret);

      const poll = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/redeem`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ redeemSecret, pairRequestId }),
      });
      expect(poll.status).toBe(202);

      const browserApprove = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/approve`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({
          requestId,
          challengeHash,
          hubId: pending.hubId,
          hubOrigin: pending.hubOrigin,
          deviceName: "Vincent's browser",
          expiresAt: pending.expiresAt,
        }),
      });
      expect(browserApprove.status).toBe(403);

      const unauthenticated = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          challengeHash,
          hubId: pending.hubId,
          hubOrigin: pending.hubOrigin,
          deviceName: "Vincent's browser",
          expiresAt: pending.expiresAt,
        }),
      });
      expect(unauthenticated.status).toBe(401);

      const approved = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({
          requestId,
          challengeHash,
          hubId: pending.hubId,
          hubOrigin: pending.hubOrigin,
          deviceName: "Vincent's browser",
          expiresAt: pending.expiresAt,
        }),
      });
      expect(approved.status).toBe(200);

      const redeemed = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/redeem`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ redeemSecret, pairRequestId }),
      });
      expect(redeemed.status).toBe(201);
      const body = (await redeemed.json()) as { token: string; device: { name: string } };
      expect(DEVICE_TOKEN_PATTERN.test(body.token)).toBe(true);
      expect(body.device.name).toBe("Vincent's browser");
      expect(devices.authenticate(body.token)?.id).toBeTruthy();

      const replay = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/redeem`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ redeemSecret, pairRequestId }),
      });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(body);

      const window = devices.openPairing();
      const classic = await fetch(`${hubOrigin}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: window.code, deviceName: "Classic phone" }),
      });
      expect(classic.status).toBe(201);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("cancels with redeem-secret proof and ignores a later approve", async () => {
    const { proxy, hubOrigin, owner } = await startHub();
    const { requestId, redeemSecret, challengeHash } = secrets();
    try {
      const created = await fetch(`${hubOrigin}/api/web-pairing/requests`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ requestId, challengeHash, deviceName: "Browser" }),
      });
      const pending = (await created.json()) as { expiresAt: number; hubId: string; hubOrigin: string };
      const cancelled = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}`, {
        method: "DELETE",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ redeemSecret }),
      });
      expect(cancelled.status).toBe(204);
      const again = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}`, {
        method: "DELETE",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ redeemSecret }),
      });
      expect(again.status).toBe(204);
      const approved = await fetch(`${hubOrigin}/api/web-pairing/requests/${requestId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({
          requestId,
          challengeHash,
          hubId: pending.hubId,
          hubOrigin: pending.hubOrigin,
          deviceName: "Browser",
          expiresAt: pending.expiresAt,
        }),
      });
      expect(approved.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
