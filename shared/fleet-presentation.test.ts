import { describe, expect, it } from "vitest";

import {
  friendlyNameFromHost,
  isGenericHubName,
  presentBridgeRoster,
  resolveHubDisplayName,
} from "./fleet-presentation.ts";

describe("fleet presentation", () => {
  it("treats legacy OpenMaus labels as generic", () => {
    expect(isGenericHubName("OpenMausBot")).toBe(true);
    expect(isGenericHubName("OpenMaus")).toBe(true);
    expect(isGenericHubName("V Bot")).toBe(true);
    expect(isGenericHubName("Studio Mac")).toBe(false);
  });

  it("derives a friendly hub name from the host when the label is generic", () => {
    expect(
      resolveHubDisplayName({
        name: "OpenMausBot",
        host: "macmini.local",
      }),
    ).toBe("Mac mini");
    expect(
      resolveHubDisplayName({
        name: "OpenMaus",
        host: "macbook.lan",
        runtimeProfile: "desktop-hub",
      }),
    ).toBe("MacBook");
  });

  it("preserves a user-assigned friendly name and alias", () => {
    expect(
      resolveHubDisplayName({
        name: "Studio Mac",
        host: "macmini.local",
      }),
    ).toBe("Studio Mac");
    expect(
      resolveHubDisplayName({
        name: "OpenMausBot",
        host: "macmini.local",
        alias: "Home Mac",
      }),
    ).toBe("Home Mac");
  });

  it("labels headless hubs from runtime profile when the name is generic", () => {
    expect(
      resolveHubDisplayName({
        name: "OpenMausBot",
        host: "192.168.1.10",
        runtimeProfile: "headless-hub",
      }),
    ).toBe("Headless V Bot hub");
  });

  it("does not treat IP addresses as computer names", () => {
    expect(friendlyNameFromHost("192.168.112.112")).toBe("Connected computer");
    expect(
      resolveHubDisplayName({
        name: "OpenMausBot",
        host: "fd00::1234",
      }),
    ).toBe("Connected computer");
  });

  it("collapses stale bridge rows only when host identity proves replacement", () => {
    const presented = presentBridgeRoster([
      {
        id: "br-old",
        name: "mini",
        hostInfo: "macmini.local",
        online: false,
        createdAt: 1,
        lastSeenAt: 2,
      },
      {
        id: "br-new",
        name: "mini",
        hostInfo: "macmini.local",
        online: true,
        createdAt: 10,
        lastSeenAt: 20,
      },
    ]);

    expect(presented.map((row) => row.entry.id)).toEqual(["br-new", "br-old"]);
    expect(presented[0]).toMatchObject({
      displayName: "mini",
      roleLabel: "Connected bridge",
      stale: false,
      hidden: false,
    });
    expect(presented[1]).toMatchObject({
      roleLabel: "Previous registration",
      stale: true,
      hidden: false,
    });
  });

  it("never merges bridges that only share a display name", () => {
    const presented = presentBridgeRoster([
      {
        id: "br-a",
        name: "mini",
        hostInfo: "macmini.local",
        online: true,
        createdAt: 1,
        lastSeenAt: 2,
      },
      {
        id: "br-b",
        name: "mini",
        hostInfo: "other-mac.local",
        online: false,
        createdAt: 3,
        lastSeenAt: 4,
      },
    ]);

    expect(presented).toHaveLength(2);
    expect(presented.every((row) => !row.stale)).toBe(true);
  });

  it("applies generic bridge naming from host evidence", () => {
    const presented = presentBridgeRoster([
      {
        id: "br-mini",
        name: "OpenMausBot",
        hostInfo: "macmini.local",
        online: true,
        createdAt: 1,
        lastSeenAt: 2,
      },
    ]);

    expect(presented[0]?.displayName).toBe("Mac mini");
  });
});
