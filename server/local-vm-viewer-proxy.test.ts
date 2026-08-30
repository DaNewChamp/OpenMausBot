import { describe, expect, it } from "vitest";

import {
  gateLocalVmPhoneJoin,
  localVmViewerJoinDeniedIfNotReady,
  localVmViewerJoinPath,
  upgradeHopByHopHeaders,
} from "./local-vm-viewer-proxy.ts";

describe("Local VM viewer join path", () => {
  it("points noVNC at the harness viewer proxy root", () => {
    const join = localVmViewerJoinPath("bot-1", { port: 6080, password: "secret" });
    expect(join.viewerPath).toMatch(/^\/api\/bots\/bot-1\/local-computer\/viewer\/vnc\.html#/);
    const fragment = join.viewerPath.slice(join.viewerPath.indexOf("#") + 1);
    const params = new URLSearchParams(fragment);
    expect(params.get("autoconnect")).toBe("true");
    expect(params.get("resize")).toBe("scale");
    expect(params.get("password")).toBe("secret");
    expect(params.get("path")).toBe("api/bots/bot-1/local-computer/viewer");
    expect(params.get("path")).not.toBe("websockify");
  });

  it("keeps websocket handshake headers", () => {
    const forwarded = upgradeHopByHopHeaders({
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "x-openmausbot-companion": "1",
    });
    expect(forwarded.upgrade).toBe("websocket");
    expect(forwarded.connection).toBe("Upgrade");
    expect(forwarded["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(forwarded["sec-websocket-version"]).toBe("13");
    expect(forwarded["x-openmausbot-companion"]).toBe("1");
  });
});

describe("Local VM phone join gate", () => {
  it("default-denies join without the companion marker", () => {
    expect(gateLocalVmPhoneJoin({
      companionMarker: undefined,
      contentType: "application/json",
      body: {},
    })).toEqual({
      status: 403,
      error: "Local VM viewer join is available only through the paired companion",
    });
  });

  it("requires an empty JSON object from the companion", () => {
    expect(gateLocalVmPhoneJoin({
      companionMarker: "1",
      contentType: "text/plain",
      body: {},
    })?.status).toBe(415);
    expect(gateLocalVmPhoneJoin({
      companionMarker: "1",
      contentType: "application/json",
      body: { command: "unsafe" },
    })?.status).toBe(400);
    expect(gateLocalVmPhoneJoin({
      companionMarker: "1",
      contentType: "application/json",
      body: {},
    })).toBeNull();
  });

  it("refuses a join when the desktop is not ready", () => {
    expect(localVmViewerJoinDeniedIfNotReady(null, null)).toEqual({
      status: 409,
      error: "The Local VM desktop is not ready for viewing.",
    });
    expect(localVmViewerJoinDeniedIfNotReady({ port: 6080, password: null }, null)).toBeNull();
  });
});
