import { describe, expect, it } from "vitest";

import {
  corsResponseHeaders,
  isBrowserSafeCompanionRoute,
  parseWebClientOrigins,
  webClientPreflightHeaders,
} from "../src/web-client-cors.ts";

describe("web client companion CORS", () => {
  it("accepts only exact configured HTTPS origins and loopback HTTP dev origins", () => {
    const origins = parseWebClientOrigins(
      "https://app.openmausbot.com, http://127.0.0.1:5199, https://evil.example/path",
    );
    expect([...origins]).toEqual(["https://app.openmausbot.com", "http://127.0.0.1:5199"]);
  });

  it("allows pairing and authenticated hub routes but not bridge, pairing-invitation mint, or web-pairing approval", () => {
    expect(isBrowserSafeCompanionRoute("POST", "/api/pair", false)).toBe(true);
    expect(isBrowserSafeCompanionRoute("GET", "/api/events", true)).toBe(true);
    expect(isBrowserSafeCompanionRoute("POST", "/api/pairing-invitations", true)).toBe(false);
    expect(isBrowserSafeCompanionRoute("POST", "/api/bridge/register", true)).toBe(false);
    expect(isBrowserSafeCompanionRoute("GET", "/api/bots", false)).toBe(false);
    expect(isBrowserSafeCompanionRoute("POST", "/api/web-pairing/requests", false)).toBe(true);
    expect(isBrowserSafeCompanionRoute("POST", "/api/web-pairing/requests/aaaaaaaaaaaaaaaaaaaaaa/redeem", false)).toBe(true);
    expect(isBrowserSafeCompanionRoute("DELETE", "/api/web-pairing/requests/aaaaaaaaaaaaaaaaaaaaaa", false)).toBe(true);
    expect(isBrowserSafeCompanionRoute("POST", "/api/web-pairing/requests/aaaaaaaaaaaaaaaaaaaaaa/approve", true)).toBe(false);
  });

  it("lets an authenticated browser answer a 1:1 approval card, and only that", () => {
    expect(isBrowserSafeCompanionRoute("POST", "/api/bots/bot_123/respond", true)).toBe(true);
    expect(isBrowserSafeCompanionRoute("POST", "/api/bots/bot_123/respond", false)).toBe(false);
    expect(isBrowserSafeCompanionRoute("PATCH", "/api/bots/bot_123/respond", true)).toBe(false);
    expect(isBrowserSafeCompanionRoute("POST", "/api/bots/bot_123/respond/extra", true)).toBe(false);
    // the chained always-allow grant is the broad bot PATCH — still closed
    expect(isBrowserSafeCompanionRoute("PATCH", "/api/bots/bot_123", true)).toBe(false);
    // pairing approve and invitation mint stay non-browser regardless
    expect(isBrowserSafeCompanionRoute("POST", "/api/web-pairing/requests/aaaaaaaaaaaaaaaaaaaaaa/approve", true)).toBe(false);
    expect(isBrowserSafeCompanionRoute("POST", "/api/pairing-invitations", true)).toBe(false);
  });

  it("builds preflight headers only for allowlisted methods and headers", () => {
    expect(
      webClientPreflightHeaders(
        "https://app.openmausbot.com",
        "POST",
        "authorization, content-type",
      ),
    ).toEqual({
      "access-control-allow-origin": "https://app.openmausbot.com",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      vary: "Origin",
    });
    expect(
      webClientPreflightHeaders("https://app.openmausbot.com", "POST", null),
    ).not.toHaveProperty("access-control-allow-headers");
    expect(webClientPreflightHeaders("https://app.openmausbot.com", "TRACE", "content-type")).toBeNull();
    expect(
      webClientPreflightHeaders("https://app.openmausbot.com", "GET", "x-evil-header"),
    ).toBeNull();
  });

  it("reflects the configured origin on responses", () => {
    expect(corsResponseHeaders("https://app.openmausbot.com")).toMatchObject({
      "access-control-allow-origin": "https://app.openmausbot.com",
    });
  });
});
