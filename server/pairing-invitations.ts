import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const PAIRING_INVITATION_TTL_MS = 120_000;
export const MAX_PAIRING_INVITATION_ATTEMPTS = 5;
export const PAIRING_INVITATION_CHALLENGE_PATTERN = /^omb_invite_[A-Za-z0-9_-]{43}$/;

export interface PairingInvitation {
  id: string;
  challenge: string;
  hubId: string;
  createdByDeviceId: string;
  expiresAt: number;
  attemptsLeft: number;
  consumedAt?: number;
}

export type PublicPairingInvitation = Omit<PairingInvitation, "challenge"> & {
  challenge?: never;
};

function sameChallenge(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isExpired(invitation: PairingInvitation, now = Date.now()): boolean {
  return invitation.expiresAt <= now || invitation.consumedAt !== undefined;
}

function normalizeInvitation(raw: Partial<PairingInvitation>): PairingInvitation | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.challenge !== "string" ||
    !PAIRING_INVITATION_CHALLENGE_PATTERN.test(raw.challenge) ||
    typeof raw.hubId !== "string" ||
    raw.hubId.length < 1 ||
    raw.hubId.length > 256 ||
    typeof raw.createdByDeviceId !== "string" ||
    raw.createdByDeviceId.length < 1 ||
    raw.createdByDeviceId.length > 256 ||
    typeof raw.expiresAt !== "number" ||
    !Number.isFinite(raw.expiresAt) ||
    typeof raw.attemptsLeft !== "number" ||
    !Number.isInteger(raw.attemptsLeft) ||
    raw.attemptsLeft < 0
  ) {
    return null;
  }
  const invitation: PairingInvitation = {
    id: raw.id,
    challenge: raw.challenge,
    hubId: raw.hubId,
    createdByDeviceId: raw.createdByDeviceId,
    expiresAt: raw.expiresAt,
    attemptsLeft: raw.attemptsLeft,
  };
  if (raw.consumedAt !== undefined) {
    if (typeof raw.consumedAt !== "number" || !Number.isFinite(raw.consumedAt)) return null;
    invitation.consumedAt = raw.consumedAt;
  }
  return invitation;
}

export class PairingInvitationRegistry {
  private invitations: PairingInvitation[] = [];
  private readonly file: string;

  constructor(dataDir: string, fileName = "pairing-invitations.json") {
    this.file = join(dataDir, fileName);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed?.invitations)) {
        this.invitations = parsed.invitations
          .map((entry: Partial<PairingInvitation>) => normalizeInvitation(entry))
          .filter((entry: PairingInvitation | null): entry is PairingInvitation => entry !== null);
      }
    } catch {
      /* first run */
    }
  }

  private persist() {
    writeFileAtomic(this.file, JSON.stringify({ invitations: this.invitations }, null, 2), { mode: 0o600 });
  }

  private prune(now = Date.now()) {
    this.invitations = this.invitations.filter((invitation) => !isExpired(invitation, now));
  }

  create(hubId: string, createdByDeviceId: string): PairingInvitation {
    const now = Date.now();
    this.prune(now);
    this.invitations = this.invitations.filter(
      (invitation) => invitation.createdByDeviceId !== createdByDeviceId,
    );
    const invitation: PairingInvitation = {
      id: randomUUID(),
      challenge: `omb_invite_${randomBytes(32).toString("base64url")}`,
      hubId,
      createdByDeviceId,
      expiresAt: now + PAIRING_INVITATION_TTL_MS,
      attemptsLeft: MAX_PAIRING_INVITATION_ATTEMPTS,
    };
    this.invitations.push(invitation);
    this.persist();
    return invitation;
  }

  listPublic(): PublicPairingInvitation[] {
    this.prune();
    return this.invitations.map(({ challenge: _challenge, ...rest }) => rest);
  }

  private burnAttempt(now: number): { error: string } | null {
    const active = this.invitations.find((entry) => !isExpired(entry, now));
    if (!active) return null;
    active.attemptsLeft -= 1;
    if (active.attemptsLeft <= 0) {
      active.consumedAt = now;
      this.persist();
      return { error: "too many incorrect codes — start pairing again" };
    }
    this.persist();
    return { error: "that pairing credential is not right" };
  }

  redeem(challenge: string): { invitation: PairingInvitation } | { error: string } {
    const presented = String(challenge ?? "");
    if (!PAIRING_INVITATION_CHALLENGE_PATTERN.test(presented)) {
      return { error: "that pairing credential is not right" };
    }
    const now = Date.now();
    this.prune(now);
    const invitation = this.invitations.find((entry) => sameChallenge(entry.challenge, presented));
    if (!invitation) {
      const burned = this.burnAttempt(now);
      return burned ?? { error: "that pairing invitation is not valid" };
    }
    if (isExpired(invitation, now)) return { error: "that pairing invitation expired" };
    invitation.consumedAt = now;
    this.persist();
    return { invitation };
  }

  invalidateForDevice(deviceId: string) {
    const before = this.invitations.length;
    this.invitations = this.invitations.filter((invitation) => invitation.createdByDeviceId !== deviceId);
    if (this.invitations.length !== before) this.persist();
  }
}
