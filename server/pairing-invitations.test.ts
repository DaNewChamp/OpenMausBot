import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PAIRING_INVITATION_ATTEMPTS,
  PAIRING_INVITATION_CHALLENGE_PATTERN,
  PAIRING_INVITATION_TTL_MS,
  PairingInvitationRegistry,
} from "./pairing-invitations.ts";

const dirs: string[] = [];

function registry() {
  const dir = mkdtempSync(join(tmpdir(), "omb-pair-invite-"));
  dirs.push(dir);
  return new PairingInvitationRegistry(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PairingInvitationRegistry", () => {
  it("creates a two-minute single-use invitation scoped to hub and creator", () => {
    const store = registry();
    const invitation = store.create("hub-1", "device-owner");
    expect(invitation.hubId).toBe("hub-1");
    expect(invitation.createdByDeviceId).toBe("device-owner");
    expect(PAIRING_INVITATION_CHALLENGE_PATTERN.test(invitation.challenge)).toBe(true);
    expect(invitation.expiresAt).toBeGreaterThan(Date.now());
    expect(invitation.expiresAt).toBeLessThanOrEqual(Date.now() + PAIRING_INVITATION_TTL_MS + 50);
    expect(invitation.attemptsLeft).toBe(MAX_PAIRING_INVITATION_ATTEMPTS);
    expect(invitation.consumedAt).toBeUndefined();
    expect(store.listPublic()).toHaveLength(1);
    expect(store.listPublic()[0]).not.toHaveProperty("challenge");
  });

  it("replaces an owner's prior invitation and redeems exactly once", () => {
    const store = registry();
    const first = store.create("hub-1", "device-owner");
    const second = store.create("hub-1", "device-owner");
    expect(store.listPublic()).toHaveLength(1);
    expect(store.listPublic()[0].id).toBe(second.id);

    const ok = store.redeem(second.challenge);
    expect("invitation" in ok && ok.invitation.id).toBe(second.id);
    const replay = store.redeem(second.challenge);
    expect(replay).toEqual({ error: "that pairing invitation is not valid" });
    expect(store.redeem(first.challenge)).toEqual({ error: "that pairing invitation is not valid" });
  });

  it("burns attempts on wrong challenges without leaking fleet state", () => {
    const store = registry();
    const invitation = store.create("hub-1", "device-owner");
    for (let index = 0; index < MAX_PAIRING_INVITATION_ATTEMPTS - 1; index += 1) {
      expect(store.redeem("omb_invite_" + "x".repeat(43))).toEqual({
        error: "that pairing credential is not right",
      });
    }
    expect(store.redeem("omb_invite_" + "y".repeat(43))).toEqual({
      error: "too many incorrect codes — start pairing again",
    });
    expect(store.redeem(invitation.challenge)).toEqual({ error: "that pairing invitation is not valid" });
  });

  it("invalidates invitations when the creating device is revoked", () => {
    const store = registry();
    const invitation = store.create("hub-1", "device-owner");
    store.invalidateForDevice("device-owner");
    expect(store.redeem(invitation.challenge)).toEqual({ error: "that pairing invitation is not valid" });
    expect(store.listPublic()).toHaveLength(0);
  });
});
