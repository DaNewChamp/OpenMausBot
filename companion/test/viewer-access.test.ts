import { describe, expect, it, beforeEach } from "vitest";

import {
  appendViewerAccessQuery,
  mintViewerAccessToken,
  parseViewerAccessCookie,
  resetViewerAccessTickets,
  resolveViewerAccessDeviceId,
  stripViewerAccessQuery,
  verifyViewerAccessToken,
  viewerAccessSetCookieHeader,
  VIEWER_ACCESS_COOKIE,
} from "../src/viewer-access.ts";

describe("viewer-access", () => {
  beforeEach(() => {
    resetViewerAccessTickets();
  });

  it("mints and verifies a scoped viewer ticket", () => {
    const token = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    expect(verifyViewerAccessToken(token, "bot_1", 1_000_000)).toBe("dev_1");
    expect(verifyViewerAccessToken(token, "bot_2", 1_000_000)).toBeNull();
  });

  it("expires viewer tickets", () => {
    const token = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    expect(verifyViewerAccessToken(token, "bot_1", 1_000_000 + 31 * 60_000)).toBeNull();
  });

  it("invalidates the prior ticket when the same device joins again", () => {
    const first = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    const second = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    expect(first).not.toBe(second);
    expect(verifyViewerAccessToken(first, "bot_1", 1_000_000)).toBeNull();
    expect(verifyViewerAccessToken(second, "bot_1", 1_000_000)).toBe("dev_1");
  });

  it("keeps the current ticket reusable for viewer subresources", () => {
    const token = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    const cookie = viewerAccessSetCookieHeader(token, "bot_1");
    expect(cookie).toContain(`${VIEWER_ACCESS_COOKIE}=`);
    expect(parseViewerAccessCookie(`${VIEWER_ACCESS_COOKIE}=${encodeURIComponent(token)}`)).toBe(token);
    expect(resolveViewerAccessDeviceId(
      "/api/bots/bot_1/local-computer/viewer/app/styles/base.css",
      `${VIEWER_ACCESS_COOKIE}=${encodeURIComponent(token)}`,
      "bot_1",
      1_000_000,
    )).toBe("dev_1");
  });

  it("isolates rotation by device and bot", () => {
    const botA = mintViewerAccessToken("dev_1", "bot_a", 1_000_000);
    const botB = mintViewerAccessToken("dev_1", "bot_b", 1_000_000);
    const otherDevice = mintViewerAccessToken("dev_2", "bot_a", 1_000_000);
    const rotated = mintViewerAccessToken("dev_1", "bot_a", 1_000_000);
    expect(verifyViewerAccessToken(botA, "bot_a", 1_000_000)).toBeNull();
    expect(verifyViewerAccessToken(rotated, "bot_a", 1_000_000)).toBe("dev_1");
    expect(verifyViewerAccessToken(botB, "bot_b", 1_000_000)).toBe("dev_1");
    expect(verifyViewerAccessToken(otherDevice, "bot_a", 1_000_000)).toBe("dev_2");
  });

  it("appends omb_viewer before the hash fragment", () => {
    const path = "/api/bots/b1/local-computer/viewer/vnc.html#autoconnect=true";
    const next = appendViewerAccessQuery(path, "ticket");
    expect(next).toBe("/api/bots/b1/local-computer/viewer/vnc.html?omb_viewer=ticket#autoconnect=true");
  });

  it("strips omb_viewer before forwarding to the harness", () => {
    const stripped = stripViewerAccessQuery(
      "/api/bots/b1/local-computer/viewer/vnc.html?omb_viewer=ticket&autoconnect=1",
    );
    expect(stripped).toBe("/api/bots/b1/local-computer/viewer/vnc.html?autoconnect=1");
  });
});
