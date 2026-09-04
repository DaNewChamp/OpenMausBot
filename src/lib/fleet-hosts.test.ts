import { describe, expect, it } from "vitest";

import {
  fleetHostLabel,
  fleetVmDeployBlockReason,
  hostsWithCapability,
  parseFleetHosts,
  preferredHostId,
  selectedFleetHostId,
} from "./fleet-hosts";

const mini = {
  id: "bridge-mini",
  name: "mini",
  online: true,
  capabilities: ["shell", "local-vm", "hermes"],
};
const windows = {
  id: "bridge-win",
  name: "windows",
  online: false,
  capabilities: ["shell"],
};

describe("fleet hosts", () => {
  it("scrubs unknown bridge rows and keeps capability lists", () => {
    expect(parseFleetHosts({
      bridges: [mini, { id: "", name: "bad" }, windows, null],
    })).toEqual([mini, windows]);
    expect(parseFleetHosts({ models: [] })).toEqual([]);
  });

  it("prefers a pinned host, then the freshest online capability match", () => {
    const hosts = parseFleetHosts({ bridges: [windows, mini] });
    expect(hostsWithCapability(hosts, "local-vm")).toEqual([mini]);
    expect(preferredHostId(hosts, "local-vm")).toBe("bridge-mini");
    expect(preferredHostId(hosts, "shell", "bridge-win")).toBe("bridge-win");
    expect(preferredHostId(hosts, "local-vm", "missing")).toBe("bridge-mini");
  });

  it("keeps an explicit fleet pick and explains why Deploy is blocked", () => {
    const hosts = parseFleetHosts({ bridges: [windows, mini] });
    expect(selectedFleetHostId(hosts, "bridge-win")).toBe("bridge-win");
    expect(selectedFleetHostId(hosts)).toBe("bridge-mini");
    expect(fleetHostLabel(mini)).toBe("mini");
    expect(fleetHostLabel(windows)).toBe("windows (offline)");
    expect(fleetVmDeployBlockReason(windows)).toContain("offline");
    expect(fleetVmDeployBlockReason({ ...windows, online: true })).toContain("isn't hosting a Linux VM");
    expect(fleetVmDeployBlockReason(mini)).toBeNull();
  });
});
