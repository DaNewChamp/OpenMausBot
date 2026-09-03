import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { companionPairingLink } from "../src/lib/companion-pairing";
import {
  parseWebPairingLink,
  redactWebPairingSecrets,
  sanitizeWebPairingDeviceName,
  serializeWebPairingLink,
  WEB_PAIRING_LINK_HOST,
  WEB_PAIRING_LINK_VERSION,
  type WebPairingLinkPayload,
} from "./web-pairing-link";

const token = `omb_pair_${"a".repeat(43)}`;

function payload(overrides: Partial<WebPairingLinkPayload> = {}): WebPairingLinkPayload {
  return {
    version: WEB_PAIRING_LINK_VERSION,
    hubOrigin: "https://hub-vbot.posival.com",
    hubId: "hub-vincent-1",
    requestId: randomBytes(16).toString("base64url"),
    challengeHash: createHash("sha256").update("secret").digest("hex"),
    deviceName: "Vincent's browser",
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

describe("web pairing QR payload", () => {
  it("serializes a versioned deep link that is not the first-device pair host", () => {
    const link = serializeWebPairingLink(payload());
    expect(link).toBeTruthy();
    const url = new URL(link!);
    expect(url.protocol).toBe("openmausbot:");
    expect(url.host).toBe(WEB_PAIRING_LINK_HOST);
    expect(url.host).not.toBe("pair");
    expect(url.searchParams.get("v")).toBe("1");
  });

  it("carries only version, hub identity/origin, request id, challenge commitment, device name, and expiry", () => {
    const input = payload();
    const url = new URL(serializeWebPairingLink(input)!);
    expect(url.searchParams.get("hub")).toBe(input.hubOrigin);
    expect(url.searchParams.get("hid")).toBe(input.hubId);
    expect(url.searchParams.get("rid")).toBe(input.requestId);
    expect(url.searchParams.get("ch")).toBe(input.challengeHash);
    expect(url.searchParams.get("n")).toBe(input.deviceName);
    expect(url.searchParams.get("exp")).toBe(String(input.expiresAt));
    expect([...url.searchParams.keys()].sort()).toEqual(["ch", "exp", "hid", "hub", "n", "rid", "v"]);
  });

  it("never puts a redeem secret, pairing code, device token, or live credential in the public payload", () => {
    const link = serializeWebPairingLink(payload())!;
    expect(link).not.toMatch(/redeem/i);
    expect(link).not.toMatch(/secret/i);
    expect(link).not.toMatch(/omb_/);
    expect(link).not.toMatch(/credential/i);
    expect(link).not.toMatch(/[?&]code=/);
    expect(link).not.toMatch(/[?&]token=/);
    const parsed = parseWebPairingLink(link);
    expect(parsed && "redeemSecret" in parsed).toBe(false);
    expect(parsed && "token" in parsed).toBe(false);
    expect(parsed && "code" in parsed).toBe(false);
  });

  it("round-trips hub and version binding", () => {
    const input = payload();
    expect(parseWebPairingLink(serializeWebPairingLink(input)!)).toEqual(input);
  });

  it("rejects a different version or a hub origin that is not a canonical origin", () => {
    const valid = serializeWebPairingLink(payload())!;
    const otherVersion = new URL(valid);
    otherVersion.searchParams.set("v", "2");
    expect(parseWebPairingLink(otherVersion.toString())).toBeNull();

    expect(serializeWebPairingLink(payload({ hubOrigin: "https://user:pass@hub.example" }))).toBeNull();
    expect(serializeWebPairingLink(payload({ hubOrigin: "https://hub.example/path" }))).toBeNull();
    expect(serializeWebPairingLink(payload({ hubOrigin: "ftp://hub.example" }))).toBeNull();
    expect(parseWebPairingLink("openmausbot://web-pair?v=1&hub=https://hub.example/path&hid=h&rid=aaaaaaaaaaaaaaaaaaaaaa&ch=" + "a".repeat(64) + "&n=Browser&exp=1")).toBeNull();
  });

  it("uses a host the old first-device parser cannot mistake for /pair", () => {
    const link = serializeWebPairingLink(payload())!;
    expect(link.startsWith("openmausbot://web-pair?")).toBe(true);
    expect(new URL(link).host).toBe("web-pair");
    expect(new URL(link).pathname).toBe("");
  });

  it("leaves the existing openmausbot://pair desktop-to-phone link unchanged", () => {
    const link = companionPairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      name: "Milind's Mac",
    })!;
    const url = new URL(link);
    expect(url.host).toBe("pair");
    expect(parseWebPairingLink(link)).toBeNull();
    expect(parseWebPairingLink("openmausbot://pair?address=mac.local&code=004209")).toBeNull();
  });

  it("rejects duplicate query keys, missing fields, and secret-bearing aliases", () => {
    const base = serializeWebPairingLink(payload())!;
    expect(parseWebPairingLink(`${base}&rid=other`)).toBeNull();
    expect(parseWebPairingLink(`${base}&token=omb_pair_${"b".repeat(43)}`)).toBeNull();
    expect(parseWebPairingLink(`${base}&code=004209`)).toBeNull();
    expect(parseWebPairingLink(`${base}&redeemSecret=aaaa`)).toBeNull();
    expect(parseWebPairingLink("openmausbot://web-pair?v=1")).toBeNull();
  });

  it("encodes device-name spaces as %20, never as +", () => {
  const link = serializeWebPairingLink({
    version: 1,
    hubOrigin: "https://hub-vbot.posival.com",
    hubId: "hub-1",
    requestId: "A".repeat(22),
    challengeHash: "a".repeat(64),
    deviceName: "Web browser",
    expiresAt: 1735689600000,
  });
  expect(link).not.toContain("+");
  expect(link).toContain("n=Web%20browser");
  expect(parseWebPairingLink(link ?? "")?.deviceName).toBe("Web browser");
});

it("sanitizes the device name before it is encoded", () => {
    expect(sanitizeWebPairingDeviceName("  Vincent\nBrowser\u0007 ")).toBe("Vincent Browser");
    expect(sanitizeWebPairingDeviceName("x".repeat(80))).toHaveLength(60);
    expect(sanitizeWebPairingDeviceName("")).toBe("Web browser");
    const link = serializeWebPairingLink(payload({ deviceName: "  Office\nMac  " }))!;
    expect(parseWebPairingLink(link)?.deviceName).toBe("Office Mac");
  });

  it("requires a 128-bit request id and a SHA-256 challenge commitment", () => {
    expect(serializeWebPairingLink(payload({ requestId: "short" }))).toBeNull();
    expect(serializeWebPairingLink(payload({ challengeHash: "abcd" }))).toBeNull();
    expect(serializeWebPairingLink(payload({ challengeHash: "A".repeat(64) }))).toBeNull();
  });

  it("redacts pairing secrets so they cannot be logged", () => {
    expect(redactWebPairingSecrets({ redeemSecret: "s", challengeHash: "c", token: "t", deviceName: "Browser" })).toEqual({
      redeemSecret: "[redacted]",
      challengeHash: "[redacted]",
      token: "[redacted]",
      deviceName: "Browser",
    });
  });
});
