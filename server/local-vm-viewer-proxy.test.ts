import { describe, expect, it } from "vitest";

import { localVmViewerJoinPath, upgradeHopByHopHeaders } from "./local-vm-viewer-proxy.ts";

describe("local VM viewer proxy", () => {
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

  it("keeps websocket handshake headers on upgrade hops", () => {
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
