import { describe, expect, it } from "vitest";

import { hostsWithCapability, parseFleetHosts, preferredHostId } from "./fleet-hosts";

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
});
