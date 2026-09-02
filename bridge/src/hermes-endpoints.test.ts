import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

describe("local Hermes endpoint discovery", () => {
  it("discovers multiple local profiles with friendly computer/profile names", async () => {
    const { discoverLocalHermesEndpoints } = await import("./hermes-endpoints.ts");
    const descriptors = discoverLocalHermesEndpoints({
      bridgeId: "bridge-mini",
      computerName: "Mac mini M4",
      capabilities: { roster: true, send: true, memory: false },
      profiles: [
        { name: "default" },
        { name: "research" },
      ],
    });
    expect(descriptors.map((row) => row.profile)).toEqual(["default", "research"]);
    expect(descriptors[0]).toMatchObject({
      endpointId: "bridge:bridge-mini:default",
      bridgeId: "bridge-mini",
      displayName: "Mac mini M4 / default",
      status: "available",
    });
    expect(descriptors[1]?.displayName).toBe("Mac mini M4 / research");
    expect(descriptors[0]?.endpointId).not.toBe(descriptors[1]?.endpointId);
  });

  it("replaces legacy OpenMaus labels with a friendly computer name", async () => {
    const { discoverLocalHermesEndpoints } = await import("./hermes-endpoints.ts");
    const [descriptor] = discoverLocalHermesEndpoints({
      bridgeId: "bridge-1",
      computerName: "OpenMausBot",
      hostInfo: "macmini.local",
      capabilities: { roster: true },
      profiles: [{ name: "default" }],
    });
    expect(descriptor?.displayName).toBe("Mac mini / default");
    expect(descriptor?.displayName).not.toMatch(/OpenMaus/i);
  });

  it("marks an unreadable profile store unavailable instead of emitting empty profiles", async () => {
    const { discoverLocalHermesEndpoints } = await import("./hermes-endpoints.ts");
    const descriptors = discoverLocalHermesEndpoints({
      bridgeId: "bridge-mini",
      computerName: "Mac mini",
      profileStore: "unreadable",
      capabilities: { roster: true },
      profiles: [{ name: "default" }, { name: "secret" }],
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      endpointId: "bridge:bridge-mini:unreadable",
      status: "unreadable",
    });
    expect(descriptors[0]?.profile).toBeUndefined();
    expect(JSON.stringify(descriptors)).not.toMatch(/secret|token|HERMES_HOME|\.hermes/i);
  });

  it("keeps duplicate installations distinct by adopted bridge identity plus profile", async () => {
    const { discoverLocalHermesEndpoints } = await import("./hermes-endpoints.ts");
    const mini = discoverLocalHermesEndpoints({
      bridgeId: "bridge-mini",
      computerName: "Mac mini",
      capabilities: { roster: true },
      profiles: [{ name: "default" }],
    });
    const laptop = discoverLocalHermesEndpoints({
      bridgeId: "bridge-laptop",
      computerName: "MacBook Pro",
      capabilities: { roster: true },
      profiles: [{ name: "default" }],
    });
    expect(mini[0]?.endpointId).toBe("bridge:bridge-mini:default");
    expect(laptop[0]?.endpointId).toBe("bridge:bridge-laptop:default");
    expect(mini[0]?.endpointId).not.toBe(laptop[0]?.endpointId);
  });

  it("changes capabilityRevision when proven capabilities change", async () => {
    const { discoverLocalHermesEndpoints } = await import("./hermes-endpoints.ts");
    const input = {
      bridgeId: "bridge-mini",
      computerName: "Mac mini",
      profiles: [{ name: "default" }],
    };
    const first = discoverLocalHermesEndpoints({
      ...input,
      capabilities: { roster: true, send: true, memory: false },
    });
    const second = discoverLocalHermesEndpoints({
      ...input,
      capabilities: { roster: true, send: true, memory: true },
    });
    expect(first[0]?.capabilityRevision).toMatch(/^[a-f0-9]{16,}$/);
    expect(second[0]?.capabilityRevision).not.toBe(first[0]?.capabilityRevision);
  });

  it("redacts secret-shaped metadata from published descriptors", async () => {
    const { discoverLocalHermesEndpoints } = await import("./hermes-endpoints.ts");
    const descriptors = discoverLocalHermesEndpoints({
      bridgeId: "bridge-mini",
      computerName: "Mac mini",
      capabilities: { roster: true },
      profiles: [{
        name: "coder",
        path: "/Users/vincent/.hermes/profiles/coder",
        token: "sk-ant-secret-value-123456",
        HERMES_HOME: "/secret/hermes",
        sessionId: "session-root-abc",
      }],
    });
    const json = JSON.stringify(descriptors);
    expect(json).not.toMatch(/sk-ant-secret-value-123456|\/Users\/vincent|HERMES_HOME|session-root/i);
    expect(descriptors[0]).toMatchObject({
      profile: "coder",
      status: "available",
    });
    expect(descriptors[0]).not.toHaveProperty("path");
    expect(descriptors[0]).not.toHaveProperty("token");
  });

  it("does not hash secret contents when deriving endpoint ids", async () => {
    const { hermesEndpointId } = await import("./hermes-endpoints.ts");
    const secret = "sk-ant-secret-value-123456";
    const id = hermesEndpointId("bridge-mini", "coder");
    expect(id).toBe("bridge:bridge-mini:coder");
    expect(id).not.toContain(secret);
    expect(createHash("sha256").update(secret).digest("hex")).not.toContain(id);
  });
});
