import { describe, expect, it } from "vitest";

import { viewerUpgradeHeaders } from "../src/viewer-upgrade-headers.ts";

describe("companion viewer websocket headers", () => {
  it("keeps the handshake and drops consumed credentials", () => {
    const forwarded = viewerUpgradeHeaders({
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "key",
      "sec-websocket-version": "13",
      authorization: "Bearer leaked",
      cookie: "session=leaked",
      origin: "https://evil.example",
      "x-openmausbot-companion": "1",
    });
    expect(forwarded).toMatchObject({
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "key",
      "sec-websocket-version": "13",
      "x-openmausbot-companion": "1",
    });
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded.origin).toBeUndefined();
  });
});
