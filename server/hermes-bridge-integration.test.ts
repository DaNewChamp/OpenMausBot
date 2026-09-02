import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { DATA_DIR } from "./config.ts";
import { encodeHermesBridgeResult } from "../shared/bridge-hermes-contract.ts";
import {
  discoverBridgeHermesPlacements,
  dispatchHermesBridgeSend,
  dispatchHermesBridgeInterrupt,
  mergeHermesSetupProfiles,
  normalizeHermesSetupPlacement,
  parseHermesSetupConnectInput,
  replayScrubbedHermesEvents,
  resolveBridgeBindingTarget,
} from "./hermes-bridge-integration.ts";
import {
  setHermesBridgeBinding,
} from "./bridge-hermes-bindings.ts";
import type { HermesSetupProfile } from "./hermes-setup.ts";

function resetBridgeData(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const file of ["bridges.json", "bridge-jobs.json", "hermes-bridge-bindings.json"]) {
    const path = join(DATA_DIR, file);
    if (existsSync(path)) rmSync(path);
  }
}

function pairedHermesBridge(name = "mini") {
  const registry = new BridgeRegistry();
  const { code } = registry.startPairing();
  const { bridgeId } = registry.register({ name, code, capabilities: ["hermes"] });
  registry.touch(bridgeId);
  return { registry, bridgeId };
}

function discoveryBody(profile = "default") {
  return {
    state: "available" as const,
    capabilities: {
      roster: true,
      canonicalChat: true,
      send: true,
      finalResponse: true,
      events: true,
      stop: true,
      routinesRead: false,
      messageAgent: false,
      groups: false,
      crossMachine: false,
      queueing: false,
      steer: false,
      attachments: false,
      adoptMint: true,
      approvals: true,
      exclusiveSubmit: false,
    },
    profiles: [{
      profile,
      handle: "hermes",
      displayName: "Hermes",
      description: "Remote assistant",
      canonicalChat: "absent" as const,
      availability: "available" as const,
    }],
  };
}

describe("Hermes bridge integration setup", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("normalizes typed local and bridge placements without bridge ids", () => {
    expect(normalizeHermesSetupPlacement({ kind: "local", profile: "default" })).toEqual({
      kind: "local",
      profile: "default",
    });
    expect(normalizeHermesSetupPlacement({ kind: "bridge", bridge: "Mac mini", profile: "work" })).toEqual({
      kind: "bridge",
      bridge: "mac mini",
      profile: "work",
    });
    expect(normalizeHermesSetupPlacement({ kind: "bridge", profile: "default" })).toBeUndefined();
    expect(normalizeHermesSetupPlacement({ bridgeId: "secret", profile: "default" })).toBeUndefined();
  });

  it("parses legacy profile-only connect bodies as local placements", () => {
    expect(parseHermesSetupConnectInput({ profile: "DEFAULT" })).toEqual({
      ok: true,
      placement: { kind: "local", profile: "default" },
    });
    expect(parseHermesSetupConnectInput({
      placement: { kind: "bridge", bridge: "mini", profile: "default" },
    })).toEqual({
      ok: true,
      placement: { kind: "bridge", bridge: "mini", profile: "default" },
    });
    expect(parseHermesSetupConnectInput({ token: "secret" })).toMatchObject({ ok: false });
  });

  it("lists online granted bridge placements by friendly bridge name and profile only", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge("Mac mini");
    const promise = discoverBridgeHermesPlacements(registry);
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({ kind: "hermes-discover", body: discoveryBody() }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    const profiles = await promise;
    expect(profiles).toEqual([expect.objectContaining({
      profile: "default",
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
    })]);
    expect(JSON.stringify(profiles)).not.toMatch(/bridgeId|HERMES_HOME|jsonrpc/i);
    vi.useRealTimers();
  });

  it("merges local and bridge profiles for setup status", () => {
    const local: HermesSetupProfile[] = [{
      profile: "default",
      handle: "hermes",
      displayName: "Hermes",
      description: "Local",
      canonicalChat: "absent",
      availability: "available",
      placement: { kind: "local", profile: "default" },
    }];
    const remote: HermesSetupProfile[] = [{
      profile: "default",
      handle: "hermes",
      displayName: "Hermes",
      description: "Remote",
      canonicalChat: "absent",
      availability: "available",
      placement: { kind: "bridge", bridge: "mini", profile: "default" },
    }];
    expect(mergeHermesSetupProfiles(local, remote)).toHaveLength(2);
  });

  it("resolves a persisted bridge binding back to a friendly bridge name", () => {
    const { registry, bridgeId } = pairedHermesBridge("office mac");
    expect(resolveBridgeBindingTarget(registry, { bridgeId, profile: "default", bindingVersion: 1 })).toEqual({
      bridge: "office mac",
      profile: "default",
    });
  });
});

describe("Hermes bridge integration dispatch", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("replays scrubbed bridge events exactly once", () => {
    const published: RuntimeEvent[] = [];
    replayScrubbedHermesEvents([
      {
        eventId: "a",
        provider: "hermesBot",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-09-01T00:00:00.000Z",
        type: "turn.started",
      },
      {
        eventId: "a",
        provider: "hermesBot",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-09-01T00:00:00.000Z",
        type: "turn.started",
      },
      {
        eventId: "b",
        provider: "hermesBot",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-09-01T00:00:00.000Z",
        type: "turn.completed",
        ok: true,
      },
    ], "hermes", (event) => published.push(event));
    expect(published.map((event) => event.eventId)).toEqual(["a", "b"]);
  });

  it("send uses sendHermesOnBridge and never falls back to local Hermes", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge();
    setHermesBridgeBinding("bot-1", { bridgeId, profile: "default", bindingVersion: 1 });
    const published: RuntimeEvent[] = [];
    const promise = dispatchHermesBridgeSend({
      registry,
      binding: { bridgeId, profile: "default", bindingVersion: 1 },
      payload: {
        text: "hello",
        threadId: "thread-1",
        turnId: "turn-1",
        model: "sonnet",
      },
      publishEvent: (event) => published.push(event),
    });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("hermes-send");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({
        kind: "hermes-send",
        body: {
          ok: true,
          turnId: "turn-1",
          events: [{
            eventId: "evt-1",
            provider: "hermesBot",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: "2026-09-01T00:00:00.000Z",
            type: "turn.completed",
            ok: true,
          }],
        },
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeUndefined();
    expect(published).toHaveLength(1);
    vi.useRealTimers();
  });

  it("fails closed when the bound bridge is offline", async () => {
    const { registry, bridgeId } = pairedHermesBridge();
    setHermesBridgeBinding("bot-1", { bridgeId, profile: "default", bindingVersion: 1 });
    const path = join(DATA_DIR, "bridges.json");
    writeFileSync(path, JSON.stringify({ bridges: [] }), { mode: 0o600 });
    await expect(dispatchHermesBridgeSend({
      registry,
      binding: { bridgeId, profile: "default", bindingVersion: 1 },
      payload: { text: "hello", threadId: "thread-1", turnId: "turn-1" },
      publishEvent: () => {},
    })).rejects.toMatchObject({ code: "gateway_unavailable" });
  });

  it("stop uses interruptHermesOnBridge", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge();
    const promise = dispatchHermesBridgeInterrupt(registry, {
      bridgeId,
      profile: "default",
      bindingVersion: 1,
    }, "turn-1");
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("hermes-interrupt");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({ kind: "hermes-interrupt", body: { ok: true } }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
