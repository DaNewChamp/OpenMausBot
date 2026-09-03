import { createHash, timingSafeEqual } from "node:crypto";

import {
  canonicalHubOrigin,
  isWebPairingChallengeHash,
  isWebPairingRequestId,
  sanitizeWebPairingDeviceName,
  WEB_PAIRING_HUB_ID_PATTERN,
  WEB_PAIRING_TTL_MS as LINK_TTL_MS,
} from "../shared/web-pairing-link.ts";

export const WEB_PAIRING_TTL_MS = LINK_TTL_MS;
export const MAX_WEB_PAIRING_ATTEMPTS = 5;
export const MAX_PENDING_WEB_PAIRING_REQUESTS = 32;
export const MAX_PENDING_WEB_PAIRING_PER_ORIGIN = 8;
export const MAX_WEB_PAIRING_REGISTERS_PER_ORIGIN = 20;
export const WEB_PAIRING_GENERIC_ERROR = "that pairing request is not valid";

export type WebPairingStatus = "pending" | "approved" | "redeemed" | "cancelled" | "expired" | "failed";

interface WebPairingReplay {
  pairRequestId: string;
  result: { device: MintedDevice; token: string };
}

interface WebPairingRecord {
  requestId: string;
  challengeHash: string;
  deviceName: string;
  origin: string;
  hubId: string;
  hubOrigin: string;
  expiresAt: number;
  attemptsLeft: number;
  status: WebPairingStatus;
  createdAt: number;
  replay?: WebPairingReplay;
}

export interface PublicWebPairingRequest {
  requestId: string;
  deviceName: string;
  origin: string;
  hubId: string;
  hubOrigin: string;
  expiresAt: number;
  status: WebPairingStatus;
}

export interface WebPairingRegistryOptions {
  ttlMs?: number;
  maxPending?: number;
  maxPendingPerOrigin?: number;
  maxRegistersPerOrigin?: number;
  maxAttempts?: number;
}

type ErrorResult = { error: string; status: number };
type MintedDevice = { id: string; name: string };
type MintDevice = (name: unknown) => { device: MintedDevice; token: string } | { error: string };

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export function sameWebPairingDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    try {
      const a = Buffer.from(left, "utf8");
      const b = Buffer.from(right, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

function generic(): ErrorResult {
  return { error: WEB_PAIRING_GENERIC_ERROR, status: 401 };
}

function canonicalOriginOrError(value: string): string | null {
  return canonicalHubOrigin(value);
}

export class WebPairingRegistry {
  private readonly records = new Map<string, WebPairingRecord>();
  private readonly registerTimes = new Map<string, number[]>();
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly maxPendingPerOrigin: number;
  private readonly maxRegistersPerOrigin: number;
  private readonly maxAttempts: number;

  constructor(options: WebPairingRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? WEB_PAIRING_TTL_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_WEB_PAIRING_REQUESTS;
    this.maxPendingPerOrigin = options.maxPendingPerOrigin ?? MAX_PENDING_WEB_PAIRING_PER_ORIGIN;
    this.maxRegistersPerOrigin = options.maxRegistersPerOrigin ?? MAX_WEB_PAIRING_REGISTERS_PER_ORIGIN;
    this.maxAttempts = options.maxAttempts ?? MAX_WEB_PAIRING_ATTEMPTS;
  }

  private prune(now: number) {
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now && record.status !== "redeemed" && record.status !== "cancelled" && record.status !== "failed") {
        record.status = "expired";
      }
      if (record.expiresAt + this.ttlMs <= now) this.records.delete(id);
    }
  }

  private pendingRecords(now: number): WebPairingRecord[] {
    this.prune(now);
    return [...this.records.values()].filter((record) => record.status === "pending" || record.status === "approved");
  }

  private originRegisterCount(origin: string, now: number): number {
    const fresh = (this.registerTimes.get(origin) ?? []).filter((at) => now - at < this.ttlMs);
    this.registerTimes.set(origin, fresh);
    return fresh.length;
  }

  private presentedSecretMatches(redeemSecret: unknown, expectedHash: string | undefined): boolean {
    const presented = typeof redeemSecret === "string" ? sha256Hex(redeemSecret) : sha256Hex("");
    const expected = expectedHash && isWebPairingChallengeHash(expectedHash) ? expectedHash : "0".repeat(64);
    const comparable = isWebPairingChallengeHash(presented) ? presented : "0".repeat(64);
    const digestOk = sameWebPairingDigest(expected, comparable);
    return Boolean(expectedHash) && isWebPairingChallengeHash(presented) && digestOk;
  }

  listPublic(now = Date.now()): PublicWebPairingRequest[] {
    this.prune(now);
    return [...this.records.values()].map(({ requestId, deviceName, origin, hubId, hubOrigin, expiresAt, status }) => ({
      requestId,
      deviceName,
      origin,
      hubId,
      hubOrigin,
      expiresAt,
      status,
    }));
  }

  register(input: {
    requestId: unknown;
    challengeHash: unknown;
    deviceName: unknown;
    origin: unknown;
    hubId: unknown;
    hubOrigin: unknown;
    now?: number;
  }): { status: "pending"; expiresAt: number; hubId: string; hubOrigin: string } | ErrorResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const challengeHash = typeof input.challengeHash === "string" ? input.challengeHash : "";
    const origin = typeof input.origin === "string" ? canonicalOriginOrError(input.origin) : null;
    const hubOrigin = typeof input.hubOrigin === "string" ? canonicalOriginOrError(input.hubOrigin) : null;
    const hubId = typeof input.hubId === "string" ? input.hubId : "";
    if (
      !isWebPairingRequestId(requestId) ||
      !isWebPairingChallengeHash(challengeHash) ||
      !origin ||
      !hubOrigin ||
      !WEB_PAIRING_HUB_ID_PATTERN.test(hubId)
    ) {
      return { error: "that pairing request is not valid", status: 400 };
    }
    if (this.records.has(requestId)) return { error: "that pairing request is not valid", status: 400 };

    const pending = this.pendingRecords(now);
    const originPending = pending.filter((record) => record.origin === origin).length;
    const originRegisters = this.originRegisterCount(origin, now);
    if (
      pending.length >= this.maxPending ||
      originPending >= this.maxPendingPerOrigin ||
      originRegisters >= this.maxRegistersPerOrigin
    ) {
      return { error: "too many pairing requests — try again in a moment", status: 429 };
    }

    const expiresAt = now + this.ttlMs;
    this.records.set(requestId, {
      requestId,
      challengeHash,
      deviceName: sanitizeWebPairingDeviceName(input.deviceName),
      origin,
      hubId,
      hubOrigin,
      expiresAt,
      attemptsLeft: this.maxAttempts,
      status: "pending",
      createdAt: now,
    });
    this.registerTimes.set(origin, [...(this.registerTimes.get(origin) ?? []), now]);
    return { status: "pending", expiresAt, hubId, hubOrigin };
  }

  approve(input: {
    requestId: unknown;
    challengeHash: unknown;
    hubId: unknown;
    hubOrigin: unknown;
    deviceName: unknown;
    expiresAt: unknown;
    now?: number;
  }): { ok: true } | ErrorResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const record = this.records.get(requestId);
    if (!record || record.status !== "pending" || record.expiresAt <= now) return generic();
    const challengeHash = typeof input.challengeHash === "string" ? input.challengeHash : "";
    const hubId = typeof input.hubId === "string" ? input.hubId : "";
    const hubOrigin = typeof input.hubOrigin === "string" ? canonicalOriginOrError(input.hubOrigin) : null;
    const deviceName = sanitizeWebPairingDeviceName(input.deviceName);
    const expiresAt = typeof input.expiresAt === "number" ? input.expiresAt : Number(input.expiresAt);
    const hashOk = isWebPairingChallengeHash(challengeHash) && sameWebPairingDigest(record.challengeHash, challengeHash);
    const hubOk = record.hubId === hubId && hubOrigin === record.hubOrigin;
    const nameOk = record.deviceName === deviceName;
    const expiryOk = record.expiresAt === expiresAt;
    if (!hashOk || !hubOk || !nameOk || !expiryOk) return generic();
    record.status = "approved";
    return { ok: true };
  }

  redeem(input: {
    requestId: unknown;
    redeemSecret: unknown;
    pairRequestId: unknown;
    mintDevice: MintDevice;
    now?: number;
  }): { pending: true } | { device: MintedDevice; token: string } | ErrorResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const pairRequestId =
      typeof input.pairRequestId === "string" && /^[A-Za-z0-9._-]{16,128}$/.test(input.pairRequestId)
        ? input.pairRequestId
        : null;
    const record = this.records.get(requestId);
    const secretOk = this.presentedSecretMatches(input.redeemSecret, record?.challengeHash);
    if (!record || record.expiresAt <= now || record.status === "cancelled" || record.status === "failed" || record.status === "expired") {
      return generic();
    }
    if (!secretOk) {
      record.attemptsLeft -= 1;
      if (record.attemptsLeft <= 0) record.status = "failed";
      return generic();
    }
    if (record.status === "pending") return { pending: true };
    if (record.status === "redeemed") {
      if (
        record.replay &&
        pairRequestId &&
        sameWebPairingDigest(sha256Hex(record.replay.pairRequestId), sha256Hex(pairRequestId))
      ) {
        return record.replay.result;
      }
      return generic();
    }
    if (record.status !== "approved") return generic();
    if (!pairRequestId) return generic();

    const minted = input.mintDevice(record.deviceName);
    if ("error" in minted) return { error: minted.error, status: minted.error.startsWith("too many paired devices") ? 401 : 500 };
    record.status = "redeemed";
    record.replay = { pairRequestId, result: minted };
    return minted;
  }

  cancel(input: { requestId: unknown; redeemSecret: unknown; now?: number }): { ok: true } | ErrorResult {
    const now = input.now ?? Date.now();
    this.prune(now);
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const record = this.records.get(requestId);
    const secretOk = this.presentedSecretMatches(input.redeemSecret, record?.challengeHash);
    if (!record) return generic();
    if (!secretOk) {
      record.attemptsLeft -= 1;
      if (record.attemptsLeft <= 0) record.status = "failed";
      return generic();
    }
    if (record.status === "cancelled") return { ok: true };
    if (record.status === "redeemed" || record.status === "failed") return generic();
    record.status = "cancelled";
    return { ok: true };
  }
}
