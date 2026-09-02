import { describe, expect, it } from "vitest";

describe("Hermes native capability negotiation", () => {
  it("marks every native capability unavailable until Hermes proves it", async () => {
    const { negotiateHermesCapabilities, HERMES_NATIVE_CAPABILITY_KEYS } = await import("./hermes-capabilities.ts");
    const manifest = negotiateHermesCapabilities({
      version: "v2026.8.31",
      observed: {},
    });
    expect(HERMES_NATIVE_CAPABILITY_KEYS).toEqual([
      "memory",
      "learning",
      "skills",
      "moa",
      "routines",
      "approvals",
      "groups",
      "messaging",
      "events",
      "finalResponse",
      "queueing",
      "steering",
      "attachments",
      "computerTools",
    ]);
    for (const key of HERMES_NATIVE_CAPABILITY_KEYS) {
      expect(manifest[key]).toBe("unavailable");
    }
  });

  it("does not infer support from a version string", async () => {
    const { negotiateHermesCapabilities } = await import("./hermes-capabilities.ts");
    const manifest = negotiateHermesCapabilities({
      version: "v2026.9.1-moa-skills",
      observed: { version: "has-moa" },
    });
    expect(manifest.moa).toBe("unavailable");
    expect(manifest.skills).toBe("unavailable");
    expect(manifest.memory).toBe("unavailable");
  });

  it("enables only capabilities Hermes actually reported as true", async () => {
    const { negotiateHermesCapabilities } = await import("./hermes-capabilities.ts");
    const manifest = negotiateHermesCapabilities({
      observed: {
        events: true,
        finalResponse: true,
        messageAgent: true,
        groups: false,
        moa: true,
      },
      descriptors: [
        {
          capabilities: {
            events: true,
            finalResponse: true,
            messaging: true,
            groups: false,
            computerTools: false,
          },
        },
      ],
    });
    expect(manifest.events).toBe("available");
    expect(manifest.finalResponse).toBe("available");
    expect(manifest.messaging).toBe("available");
    expect(manifest.moa).toBe("available");
    expect(manifest.groups).toBe("unavailable");
    expect(manifest.computerTools).toBe("unavailable");
    expect(manifest.learning).toBe("unavailable");
  });

  it("intersects multiple endpoint descriptors conservatively", async () => {
    const { negotiateHermesCapabilities } = await import("./hermes-capabilities.ts");
    const manifest = negotiateHermesCapabilities({
      descriptors: [
        { capabilities: { events: true, skills: true, groups: true } },
        { capabilities: { events: true, skills: false, groups: true } },
      ],
    });
    expect(manifest.events).toBe("available");
    expect(manifest.skills).toBe("unavailable");
    expect(manifest.groups).toBe("available");
  });

  it("ignores secret-shaped capability keys", async () => {
    const { negotiateHermesCapabilities } = await import("./hermes-capabilities.ts");
    const manifest = negotiateHermesCapabilities({
      observed: { token: true, HERMES_HOME: true, events: true },
    });
    expect(manifest.events).toBe("available");
    expect(JSON.stringify(manifest)).not.toMatch(/token|HERMES_HOME|\/Users\//i);
  });
});
