import assert from "node:assert/strict";
import test from "node:test";

import { localVmViewerJoinPath, upgradeHopByHopHeaders } from "./local-vm-viewer-proxy.ts";

test("localVmViewerJoinPath points noVNC at the harness viewer proxy root", () => {
  const join = localVmViewerJoinPath("bot-1", { port: 6080, password: "secret" });
  assert.match(join.viewerPath, /^\/api\/bots\/bot-1\/local-computer\/viewer\/vnc\.html#/);
  const fragment = join.viewerPath.slice(join.viewerPath.indexOf("#") + 1);
  const params = new URLSearchParams(fragment);
  assert.equal(params.get("autoconnect"), "true");
  assert.equal(params.get("resize"), "scale");
  assert.equal(params.get("password"), "secret");
  assert.equal(params.get("path"), "api/bots/bot-1/local-computer/viewer");
  assert.notEqual(params.get("path"), "websockify");
});

test("upgradeHopByHopHeaders keeps websocket handshake headers", () => {
  const forwarded = upgradeHopByHopHeaders({
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    "x-openmausbot-companion": "1",
  });
  assert.equal(forwarded.upgrade, "websocket");
  assert.equal(forwarded.connection, "Upgrade");
  assert.equal(forwarded["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
  assert.equal(forwarded["sec-websocket-version"], "13");
  assert.equal(forwarded["x-openmausbot-companion"], "1");
});
