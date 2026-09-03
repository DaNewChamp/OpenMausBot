import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebClientGate, WEB_PAIR_GATE_COPY, WebPairQrPane } from "./WebClientShell";
import { WEB_CLIENT_NAV_ITEMS, webClientLayout } from "@/lib/web-client-layout";
import {
  assertHubApiReady,
  canCallHubApi,
  clearHubConnection,
  setHubApiBase,
  setHubDeviceToken,
} from "@/lib/web-client-session";
import { serializeWebPairingLink } from "../../shared/web-pairing-link";

describe("WebClientShell", () => {
  it("describes the gate and blocks hub API access before pairing", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
    expect(WebClientGate.name).toBe("WebClientGate");
    expect(() => assertHubApiReady()).toThrow(/pairing/i);
  });

  it("paints Pair this browser with Enter pairing code and Scan QR code, and labels the code field Pairing code", () => {
    const html = renderToStaticMarkup(
      createElement(WebClientGate, { session: { hub: null }, onSessionChange: () => undefined }),
    );
    expect(html).toContain(WEB_PAIR_GATE_COPY.title);
    expect(html).toContain(WEB_PAIR_GATE_COPY.enterCode);
    expect(html).toContain(WEB_PAIR_GATE_COPY.scanQr);
    expect(html).toContain(WEB_PAIR_GATE_COPY.pairingCode);
    expect(html).not.toMatch(/invitation/i);
    expect(html).not.toMatch(/sign in/i);
    expect(html).not.toMatch(/account/i);
    expect(html.indexOf("Hub address")).toBeGreaterThan(html.indexOf("Advanced"));
  });

  it("renders a QR from the versioned web-pair link and offers refresh after expiry", () => {
    const link = serializeWebPairingLink({
      version: 1,
      hubOrigin: "https://hub-vbot.posival.com",
      hubId: "hub-1",
      requestId: "a".repeat(22),
      challengeHash: "b".repeat(64),
      deviceName: "Web browser",
      expiresAt: Date.now() + 60_000,
    });
    const qr = renderToStaticMarkup(
      createElement(WebPairQrPane, { link, expired: false, onRefresh: () => undefined }),
    );
    expect(qr).toContain("svg");
    expect(qr).toContain(WEB_PAIR_GATE_COPY.scanHint);
    expect(qr).toContain(WEB_PAIR_GATE_COPY.waiting);
    expect(qr).toContain(WEB_PAIR_GATE_COPY.refresh);
    const expired = renderToStaticMarkup(
      createElement(WebPairQrPane, { link: null, expired: true, onRefresh: () => undefined }),
    );
    expect(expired).toContain(WEB_PAIR_GATE_COPY.expired);
    const failed = renderToStaticMarkup(
      createElement(WebPairQrPane, {
        link: null,
        expired: false,
        error: "Could not reach that hub. Check the address and your connection.",
        onRefresh: () => undefined,
      }),
    );
    expect(failed).toContain("Could not reach that hub");
  });

  it("defines the compact Grok desktop chrome instead of section navigation", () => {
    expect(WEB_CLIENT_NAV_ITEMS).toEqual(["Bots", "Rooms", "Find", "Account"]);
    expect(webClientLayout()).toEqual({
      leftRail: "bots",
      main: "conversation",
      rightPane: "on-demand",
      trafficLights: false,
    });
  });

  it("requires hub pairing before connector preload can run", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
  });

  it("allows hub API access only after pairing credentials are in memory", () => {
    setHubApiBase("https://hub.example");
    setHubDeviceToken("omb_" + "c".repeat(43));
    expect(canCallHubApi()).toBe(true);
    clearHubConnection();
  });
});

describe("WebClientShell", () => {
  it("describes the gate and blocks hub API access before pairing", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
    expect(WebClientGate.name).toBe("WebClientGate");
    expect(() => assertHubApiReady()).toThrow(/pairing/i);
  });

  it("defines the compact Grok desktop chrome instead of section navigation", () => {
    expect(WEB_CLIENT_NAV_ITEMS).toEqual(["Bots", "Rooms", "Find", "Account"]);
    expect(webClientLayout()).toEqual({
      leftRail: "bots",
      main: "conversation",
      rightPane: "on-demand",
      trafficLights: false,
    });
  });

  it("requires hub pairing before connector preload can run", () => {
    clearHubConnection();
    expect(canCallHubApi()).toBe(false);
  });

  it("allows hub API access only after pairing credentials are in memory", () => {
    setHubApiBase("https://hub.example");
    setHubDeviceToken("omb_" + "c".repeat(43));
    expect(canCallHubApi()).toBe(true);
    clearHubConnection();
  });
});
