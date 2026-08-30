import { describe, expect, it } from "vitest";

import { bridgeHealth, computerEngineBadge, sanitizeProviderCatalog } from "./shell-status";

describe("shell engine and bridge badges", () => {
  it("labels Local VM and VPS as first-class V Bot engines", () => {
    expect(computerEngineBadge({ computer: "vm" })).toEqual({ kind: "vm", label: "Local VM" });
    expect(computerEngineBadge({ computer: "cloud", cloudBackend: "vps" })).toEqual({
      kind: "vps",
      label: "VPS engine",
    });
  });

  it("treats a live demo bridge as connected", () => {
    expect(bridgeHealth({ demo: true }).label).toBe("Bridge live");
    expect(bridgeHealth({ companionEnabled: true, liveCount: 1 }).kind).toBe("connected");
    expect(bridgeHealth({ companionEnabled: true, pairedCount: 1 }).kind).toBe("pairing");
  });

  it("strips provider secrets from the mobile catalog", () => {
    const catalog = sanitizeProviderCatalog([
      {
        instanceId: "demo-grok",
        displayName: "Grok",
        driverKind: "grok",
        models: { default: "grok-4", options: [{ id: "grok-4", label: "Grok 4" }] },
      },
    ]);
    expect(catalog).toEqual([{ id: "demo-grok", name: "Grok", driver: "grok", defaultModel: "grok-4" }]);
    expect(JSON.stringify(catalog)).not.toMatch(/key|token|secret|sk-/i);
  });
});
