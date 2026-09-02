import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceRegistry, DEVICE_TOKEN_PATTERN } from "../src/devices.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { PairingInvitationRegistry } from "../../server/pairing-invitations.ts";

const dirs: string[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pairing invitations through the companion proxy", () => {
  it("lets a paired owner mint a challenge and a new client redeem it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-companion-invite-"));
    dirs.push(dir);
    const devices = new DeviceRegistry();
    const invitations = new PairingInvitationRegistry(dir);
    const hubId = "hub-test-1";
    devices.setRevokeListener((deviceId) => invitations.invalidateForDevice(deviceId));

    const owner = devices.mintDevice("Owner phone");
    if ("error" in owner) throw new Error(owner.error);

    const proxy = createServer(
      createProxyHandler({
        harnessPort: 8799,
        authenticate: (token) => devices.authenticate(token),
        redeem: (credential, deviceName) => {
          if (credential.startsWith("omb_invite_")) {
            const redeemed = invitations.redeem(credential);
            if ("error" in redeemed) return redeemed;
            if (redeemed.invitation.hubId !== hubId) return { error: "that pairing invitation is not valid" };
            return devices.mintDevice(deviceName);
          }
          return devices.redeem(credential, deviceName);
        },
        serverName: () => "Test Hub",
        createPairingInvitation: (deviceId) => {
          const invitation = invitations.create(hubId, deviceId);
          return {
            id: invitation.id,
            challenge: invitation.challenge,
            hubId: invitation.hubId,
            expiresAt: invitation.expiresAt,
            attemptsLeft: invitation.attemptsLeft,
          };
        },
      }),
    );

    const port = await listen(proxy);
    const base = `http://127.0.0.1:${port}`;

    const created = await fetch(`${base}/api/pairing-invitations`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { challenge: string };
    expect(payload.challenge).toMatch(/^omb_invite_/);

    const paired = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: payload.challenge, deviceName: "Web browser" }),
    });
    expect(paired.status).toBe(201);
    const body = (await paired.json()) as { token: string };
    expect(DEVICE_TOKEN_PATTERN.test(body.token)).toBe(true);

    const replay = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: payload.challenge, deviceName: "Other browser" }),
    });
    expect(replay.status).toBe(401);

    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
});
