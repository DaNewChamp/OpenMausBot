import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceRegistry } from "../src/devices.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { PairingInvitationRegistry } from "../../server/pairing-invitations.ts";

const dirs: string[] = [];
const WEB_ORIGIN = "https://app.openmausbot.test";

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

describe("web client companion CORS proxy", () => {
  it("allows allowlisted browser origins to pair and rejects unknown origins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-companion-cors-"));
    dirs.push(dir);
    const devices = new DeviceRegistry();
    const invitations = new PairingInvitationRegistry(dir);
    const hubId = "hub-cors-1";
    const owner = devices.mintDevice("Owner");
    if ("error" in owner) throw new Error(owner.error);
    const invitation = invitations.create(hubId, owner.device.id);

    const proxy = createServer(
      createProxyHandler({
        harnessPort: 8799,
        authenticate: (token) => devices.authenticate(token),
        redeem: (credential, deviceName) => {
          const reserved = invitations.prepareRedeem(credential, hubId);
          if ("error" in reserved) return reserved;
          const minted = devices.mintDevice(deviceName);
          if ("error" in minted) {
            invitations.abortRedeem(credential);
            return minted;
          }
          invitations.finalizeRedeem(credential);
          return minted;
        },
        serverName: () => "Test Hub",
        webClientOrigins: new Set([WEB_ORIGIN]),
      }),
    );

    const port = await listen(proxy);
    const base = `http://127.0.0.1:${port}`;
    try {
      const preflight = await fetch(`${base}/api/pair`, {
        method: "OPTIONS",
        headers: {
          origin: WEB_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);

      const paired = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ credential: invitation.challenge, deviceName: "Browser" }),
      });
      expect(paired.status).toBe(201);
      expect(paired.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);

      const blocked = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ credential: invitation.challenge, deviceName: "Evil" }),
      });
      expect(blocked.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
