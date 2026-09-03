import { rmSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../companion/src/state.ts";
import { DeviceRegistry, MAX_DEVICES } from "../companion/src/devices.ts";
import {
  WEB_PAIRING_GENERIC_ERROR,
  WEB_PAIRING_TTL_MS,
  WebPairingRegistry,
} from "./web-pairing-requests.ts";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secrets() {
  const requestId = randomBytes(16).toString("base64url");
  const redeemSecret = randomBytes(32).toString("base64url");
  return { requestId, redeemSecret, challengeHash: sha256Hex(redeemSecret) };
}

function register(
  registry: WebPairingRegistry,
  extra: Record<string, unknown> = {},
) {
  const generated = secrets();
  const result = registry.register({
    requestId: generated.requestId,
    challengeHash: generated.challengeHash,
    deviceName: "Vincent's browser",
    origin: "https://vbot.posival.com",
    hubId: "hub-1",
    hubOrigin: "https://hub-vbot.posival.com",
    ...extra,
  });
  return { ...generated, result };
}

describe("WebPairingRegistry", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("stores a pending request without the redeem secret and returns only pending+expiry+hub binding", () => {
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret, challengeHash, result } = register(registry);
    expect(result).toMatchObject({
      status: "pending",
      hubId: "hub-1",
      hubOrigin: "https://hub-vbot.posival.com",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + WEB_PAIRING_TTL_MS);
    expect(JSON.stringify(result)).not.toContain(redeemSecret);
    expect(JSON.stringify(registry.listPublic())).not.toContain(redeemSecret);
    expect(JSON.stringify(registry.listPublic())).not.toContain(challengeHash);
    const listed = registry.listPublic().find((entry) => entry.requestId === requestId);
    expect(listed).toMatchObject({ status: "pending", hubId: "hub-1" });
    expect(listed).not.toHaveProperty("redeemSecret");
    expect(listed).not.toHaveProperty("challengeHash");
  });

  it("rejects malformed ids, hashes, origins, and over-long names at registration", () => {
    const registry = new WebPairingRegistry();
    expect(register(registry, { requestId: "short" }).result).toMatchObject({ status: 400 });
    expect(register(registry, { challengeHash: "abcd" }).result).toMatchObject({ status: 400 });
    expect(register(registry, { origin: "https://evil.example/path" }).result).toMatchObject({ status: 400 });
    expect(register(registry, { hubOrigin: "https://user:pass@hub.example" }).result).toMatchObject({
      status: 400,
    });
  });

  it("rate-limits and bounds the pending registry per origin", () => {
    const registry = new WebPairingRegistry({ maxPending: 3, maxPendingPerOrigin: 2, maxRegistersPerOrigin: 2 });
    expect(register(registry).result).toHaveProperty("status", "pending");
    expect(register(registry).result).toHaveProperty("status", "pending");
    expect(register(registry).result).toMatchObject({ status: 429 });
    expect(register(registry, { origin: "https://app.openmausbot.com" }).result).toHaveProperty("status", "pending");
    expect(register(registry, { origin: "https://app.openmausbot.com" }).result).toMatchObject({ status: 429 });
  });

  it("lets an origin register again after the rate window expires", () => {
    const registry = new WebPairingRegistry({ maxRegistersPerOrigin: 1, maxPendingPerOrigin: 8 });
    expect(register(registry, { now: 1_000 }).result).toHaveProperty("status", "pending");
    expect(register(registry, { now: 1_000 }).result).toMatchObject({ status: 429 });
    expect(register(registry, { now: 1_000 + WEB_PAIRING_TTL_MS }).result).toHaveProperty("status", "pending");
  });

  it("approves only the exact stored tuple and then lets the browser redeem once", () => {
    const devices = new DeviceRegistry();
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret, challengeHash, result } = register(registry);
    if ("error" in result) throw new Error(result.error);

    expect(
      registry.approve({
        requestId,
        challengeHash: "0".repeat(64),
        hubId: "hub-1",
        hubOrigin: "https://hub-vbot.posival.com",
        deviceName: "Vincent's browser",
        expiresAt: result.expiresAt,
      }),
    ).toMatchObject({ status: 401 });

    expect(
      registry.approve({
        requestId,
        challengeHash,
        hubId: "hub-1",
        hubOrigin: "https://hub-vbot.posival.com",
        deviceName: "Vincent's browser",
        expiresAt: result.expiresAt,
      }),
    ).toEqual({ ok: true });

    const minted = registry.redeem({
      requestId,
      redeemSecret,
      pairRequestId: "idempotency-key-approved-1",
      mintDevice: (name) => devices.mintDevice(name),
    });
    expect(minted).toMatchObject({ token: expect.stringMatching(/^omb_/), device: { name: "Vincent's browser" } });
    if ("error" in minted || "pending" in minted) throw new Error("expected mint");
    expect(devices.authenticate(minted.token)?.id).toBe(minted.device.id);
  });

  it("returns 202-style pending before approval and replays the same minted device for a lost response", () => {
    const devices = new DeviceRegistry();
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret, challengeHash, result } = register(registry);
    if ("error" in result) throw new Error(result.error);

    expect(
      registry.redeem({
        requestId,
        redeemSecret,
        pairRequestId: "same-logical-redeem-01",
        mintDevice: (name) => devices.mintDevice(name),
      }),
    ).toEqual({ pending: true });

    registry.approve({
      requestId,
      challengeHash,
      hubId: "hub-1",
      hubOrigin: "https://hub-vbot.posival.com",
      deviceName: "Vincent's browser",
      expiresAt: result.expiresAt,
    });

    const first = registry.redeem({
      requestId,
      redeemSecret,
      pairRequestId: "same-logical-redeem-01",
      mintDevice: (name) => devices.mintDevice(name),
    });
    const replay = registry.redeem({
      requestId,
      redeemSecret,
      pairRequestId: "same-logical-redeem-01",
      mintDevice: (name) => devices.mintDevice(name),
    });
    expect(first).toEqual(replay);
    if ("error" in first || "pending" in first) throw new Error("expected mint");
    expect(devices.count()).toBe(1);
    expect(
      registry.redeem({
        requestId,
        redeemSecret,
        pairRequestId: "a-different-logical-key",
        mintDevice: (name) => devices.mintDevice(name),
      }),
    ).toMatchObject({ error: WEB_PAIRING_GENERIC_ERROR });
    expect(devices.count()).toBe(1);
  });

  it("makes a wrong secret indistinguishable from an unknown request and burns attempts", () => {
    const devices = new DeviceRegistry();
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret, result } = register(registry);
    if ("error" in result) throw new Error(result.error);
    const unknown = registry.redeem({
      requestId: randomBytes(16).toString("base64url"),
      redeemSecret: randomBytes(32).toString("base64url"),
      pairRequestId: "unknown-request-key-1",
      mintDevice: (name) => devices.mintDevice(name),
    });
    const wrong = registry.redeem({
      requestId,
      redeemSecret: randomBytes(32).toString("base64url"),
      pairRequestId: "wrong-secret-key-0001",
      mintDevice: (name) => devices.mintDevice(name),
    });
    expect(unknown).toEqual(wrong);
    expect(unknown).toMatchObject({ error: WEB_PAIRING_GENERIC_ERROR, status: 401 });

    for (let i = 0; i < 8; i += 1) {
      expect(
        registry.redeem({
          requestId,
          redeemSecret: randomBytes(32).toString("base64url"),
          pairRequestId: `wrong-${i}-abcdefghij`,
          mintDevice: (name) => devices.mintDevice(name),
        }),
      ).toMatchObject({ error: WEB_PAIRING_GENERIC_ERROR, status: 401 });
    }
    expect(
      registry.redeem({
        requestId,
        redeemSecret,
        pairRequestId: "after-burn-key-0000001",
        mintDevice: (name) => devices.mintDevice(name),
      }),
    ).toMatchObject({ error: WEB_PAIRING_GENERIC_ERROR, status: 401 });
    expect(registry.listPublic().find((entry) => entry.requestId === requestId)?.status).toBe("failed");
  });

  it("rejects expired, cancelled, and mismatched approval tuples as a single terminal outcome", () => {
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret, challengeHash, result } = register(registry);
    if ("error" in result) throw new Error(result.error);

    expect(
      registry.approve({
        requestId,
        challengeHash,
        hubId: "other-hub",
        hubOrigin: "https://hub-vbot.posival.com",
        deviceName: "Vincent's browser",
        expiresAt: result.expiresAt,
      }),
    ).toMatchObject({ status: 401 });

    expect(registry.cancel({ requestId, redeemSecret })).toEqual({ ok: true });
    expect(registry.cancel({ requestId, redeemSecret })).toEqual({ ok: true });
    expect(
      registry.approve({
        requestId,
        challengeHash,
        hubId: "hub-1",
        hubOrigin: "https://hub-vbot.posival.com",
        deviceName: "Vincent's browser",
        expiresAt: result.expiresAt,
      }),
    ).toMatchObject({ status: 401 });

    const expired = new WebPairingRegistry();
    const created = register(expired, { now: 1_000 });
    if ("error" in created.result) throw new Error(created.result.error);
    expect(
      expired.approve({
        requestId: created.requestId,
        challengeHash: created.challengeHash,
        hubId: "hub-1",
        hubOrigin: "https://hub-vbot.posival.com",
        deviceName: "Vincent's browser",
        expiresAt: created.result.expiresAt,
        now: 1_000 + WEB_PAIRING_TTL_MS + 1,
      }),
    ).toMatchObject({ status: 401 });
  });

  it("cancels only with redeem-secret proof and does not leak existence", () => {
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret } = register(registry);
    expect(registry.cancel({ requestId, redeemSecret: randomBytes(32).toString("base64url") })).toMatchObject({
      error: WEB_PAIRING_GENERIC_ERROR,
      status: 401,
    });
    expect(
      registry.cancel({ requestId: randomBytes(16).toString("base64url"), redeemSecret }),
    ).toMatchObject({ error: WEB_PAIRING_GENERIC_ERROR, status: 401 });
    expect(registry.cancel({ requestId, redeemSecret })).toEqual({ ok: true });
  });

  it("enforces MAX_DEVICES and rolls back a persistence failure without leaving a device", () => {
    const devices = new DeviceRegistry();
    for (let i = 0; i < MAX_DEVICES; i += 1) {
      const minted = devices.mintDevice(`phone-${i}`);
      if ("error" in minted) throw new Error(minted.error);
    }
    const registry = new WebPairingRegistry();
    const { requestId, redeemSecret, challengeHash, result } = register(registry);
    if ("error" in result) throw new Error(result.error);
    registry.approve({
      requestId,
      challengeHash,
      hubId: "hub-1",
      hubOrigin: "https://hub-vbot.posival.com",
      deviceName: "Vincent's browser",
      expiresAt: result.expiresAt,
    });
    const capped = registry.redeem({
      requestId,
      redeemSecret,
      pairRequestId: "device-cap-key-000001",
      mintDevice: (name) => devices.mintDevice(name),
    });
    expect(capped).toMatchObject({ error: expect.stringMatching(/too many paired devices/i) });
    expect(devices.count()).toBe(MAX_DEVICES);

    rmSync(DATA_DIR, { recursive: true, force: true });
    const rolling = new DeviceRegistry();
    const second = new WebPairingRegistry();
    const created = register(second);
    if ("error" in created.result) throw new Error(created.result.error);
    second.approve({
      requestId: created.requestId,
      challengeHash: created.challengeHash,
      hubId: "hub-1",
      hubOrigin: "https://hub-vbot.posival.com",
      deviceName: "Vincent's browser",
      expiresAt: created.result.expiresAt,
    });
    const failed = second.redeem({
      requestId: created.requestId,
      redeemSecret: created.redeemSecret,
      pairRequestId: "persist-rollback-key-01",
      mintDevice: (name) => {
        const minted = rolling.mintDevice(name);
        if ("error" in minted) return minted;
        rolling.revoke(minted.device.id);
        return { error: "could not save the pairing: disk full" };
      },
    });
    expect(failed).toMatchObject({ error: expect.stringMatching(/could not save the pairing/i) });
    expect(rolling.count()).toBe(0);
  });

  it("uses constant-time digest comparison for challenge hashes", async () => {
    const { sameWebPairingDigest } = await import("./web-pairing-requests.ts");
    expect(sameWebPairingDigest("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(sameWebPairingDigest("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(timingSafeEqual(Buffer.from("aa", "hex"), Buffer.from("aa", "hex"))).toBe(true);
  });
});
