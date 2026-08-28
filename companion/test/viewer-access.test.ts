import { describe, expect, it } from "vitest";

import {
  appendViewerAccessQuery,
  mintViewerAccessToken,
  parseViewerAccessCookie,
  resolveViewerAccessDeviceId,
  stripViewerAccessQuery,
  verifyViewerAccessToken,
  viewerAccessSetCookieHeader,
  VIEWER_ACCESS_COOKIE,
} from "../src/viewer-access.ts";

describe("viewer-access", () => {
  it("mints and verifies a scoped viewer ticket", () => {
    const token = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    expect(verifyViewerAccessToken(token, "bot_1", 1_000_000)).toBe("dev_1");
    expect(verifyViewerAccessToken(token, "bot_2", 1_000_000)).toBeNull();
  });

  it("expires viewer tickets", () => {
    const token = mintViewerAccessToken("dev_1", "bot_1", 1_000_000);
    expect(verifyViewerAccessToken(token, "bot_1", 1_000_000 + 31 * 60_000)).toBeNull();
  });

  it("appends omb_viewer before the hash fragment", () => {
    const path = "/api/bots/b1/local-computer/viewer/vnc.html#autoconnect=true";
    const next = appendViewerAccessQuery(path, "ticket");
    expect(next).toBe("/api/bots/b1/local-computer/viewer/vnc.html?omb_viewer=ticket#autoconnect=true");
  });

  it("authenticates viewer subresources from the scoped cookie", () => {
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

  it("strips omb_viewer before forwarding to the harness", () => {
    const stripped = stripViewerAccessQuery(
      "/api/bots/b1/local-computer/viewer/vnc.html?omb_viewer=ticket&autoconnect=1",
    );
    expect(stripped).toBe("/api/bots/b1/local-computer/viewer/vnc.html?autoconnect=1");
  });
});
