// The bind hosts are the package's core invariant: the control plane (pairing
// and revocation) must stay on loopback, and only the device port may face the
// network. Both were previously guaranteed by a string literal inside a
// listen() call and a comment — a one-character edit could expose the pairing
// plane to the LAN with every test still green. These constants are what the
// listen() calls now use, so pinning them here is pinning the real bind.
import { describe, expect, it } from "vitest";

import { CONTROL_HOST, DEVICE_HOST } from "../src/index.ts";

describe("bind hosts", () => {
  it("keeps the control plane on loopback", () => {
    expect(CONTROL_HOST).toBe("127.0.0.1");
  });

  it("exposes only the device port to the network", () => {
    expect(DEVICE_HOST).toBe("0.0.0.0");
  });

  it("never lets the two hosts converge on one network-facing bind", () => {
    // if both were "0.0.0.0", pairing would be reachable off-machine
    expect(CONTROL_HOST).not.toBe(DEVICE_HOST);
    expect(CONTROL_HOST).not.toBe("0.0.0.0");
  });
});
