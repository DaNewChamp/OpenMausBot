import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebClientGate, WEB_PAIR_GATE_COPY, WebPairQrPane } from "./WebClientShell";
import { WEB_CLIENT_NAV_ITEMS, webClientLayout } from "@/lib/web-client-layout";
import {
  assertHubApiReady,
  canCallHubApi,
  clearHubConnection,
  DEFAULT_WEB_HUB_URL,
  setHubApiBase,
  setHubDeviceToken,
} from "@/lib/web-client-session";
import {
  hubUnreachableCopy,
  QR_UNREACHABLE_CHECK_ADDRESS,
  QR_UNREACHABLE_DEFAULT,
} from "@/lib/web-pairing-gate";
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

  it("renders a QR countdown, Cancel / Start over, expired refresh, and default-hub unreachable copy", () => {
    const link = serializeWebPairingLink({
      version: 1,
      hubOrigin: "https://hub-vbot.posival.com",
      hubId: "hub-1",
      requestId: "a".repeat(22),
      challengeHash: "b".repeat(64),
      deviceName: "Web browser",
      expiresAt: Date.now() + 60_000,
    });
    const now = 1_700_000_000_000;
    const qr = renderToStaticMarkup(
      createElement(WebPairQrPane, {
        link,
        expired: false,
        expiresAt: now + 87_000,
        now,
        onRefresh: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(qr).toContain("svg");
    expect(qr).toContain(WEB_PAIR_GATE_COPY.scanHint);
    expect(qr).toContain(WEB_PAIR_GATE_COPY.waiting);
    expect(qr).toContain(WEB_PAIR_GATE_COPY.refresh);
    expect(qr).toContain("Expires in 87 seconds");
    expect(qr).toContain(WEB_PAIR_GATE_COPY.cancel);
    expect(qr).toContain("data-web-pair-cancel");
    expect(qr).not.toMatch(/redeemSecret|omb_/i);
    const expired = renderToStaticMarkup(
      createElement(WebPairQrPane, {
        link: null,
        expired: true,
        expiresAt: now - 1,
        now,
        onRefresh: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(expired).toContain(WEB_PAIR_GATE_COPY.expired);
    expect(expired).toContain(WEB_PAIR_GATE_COPY.refresh);
    expect(expired).toContain(WEB_PAIR_GATE_COPY.cancel);
    expect(expired).not.toContain("Expires in");
    const timedOut = renderToStaticMarkup(
      createElement(WebPairQrPane, {
        link,
        expired: false,
        expiresAt: now - 1,
        now,
        onRefresh: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(timedOut).toContain(WEB_PAIR_GATE_COPY.expired);
    expect(timedOut).not.toContain("Expires in");
    const failed = renderToStaticMarkup(
      createElement(WebPairQrPane, {
        link: null,
        expired: false,
        error: hubUnreachableCopy({ hubUrl: DEFAULT_WEB_HUB_URL, advancedOpen: false }),
        onRefresh: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(failed).toContain(QR_UNREACHABLE_DEFAULT);
    expect(failed).not.toMatch(/address/i);
    const customHub = renderToStaticMarkup(
      createElement(WebPairQrPane, {
        link: null,
        expired: false,
        error: hubUnreachableCopy({ hubUrl: "https://hub.example:8810", advancedOpen: false }),
        onRefresh: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(customHub).toContain(QR_UNREACHABLE_CHECK_ADDRESS);
  });

  it("defines three-column Grok desktop chrome with a computer pane", () => {
    expect(WEB_CLIENT_NAV_ITEMS).toEqual(["Bots", "Rooms", "Find", "Account"]);
    expect(webClientLayout()).toEqual({
      leftRail: "bots",
      main: "conversation",
      rightPane: "computer",
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
