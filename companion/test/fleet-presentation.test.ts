import { hostname } from "node:os";
import { describe, expect, it } from "vitest";

import { resolveHubDisplayName } from "../src/fleet-presentation.ts";

describe("companion fleet naming", () => {
  it("falls back to a host-derived V Bot label instead of OpenMausBot", () => {
    expect(
      resolveHubDisplayName({
        name: "",
        host: "macmini.local",
        runtimeProfile: "desktop-hub",
      }),
    ).toBe("Mac mini");
    expect(
      resolveHubDisplayName({
        name: "OpenMausBot",
        host: hostname(),
        runtimeProfile: "desktop-hub",
      }),
    ).not.toBe("OpenMausBot");
  });
});
