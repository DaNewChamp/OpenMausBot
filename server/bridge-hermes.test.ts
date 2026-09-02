import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import {
  discoverHermesOnBridge,
  ensureCanonicalHermesOnBridge,
  HermesBridgeUnavailableError,
  interruptHermesOnBridge,
  sendHermesOnBridge,
} from "./bridge-hermes.ts";
import { encodeHermesBridgeResult } from "../shared/bridge-hermes-contract.ts";

function pairedHermesBridge() {
  const registry = new BridgeRegistry();
  const { code } = registry.startPairing();
  const { bridgeId, bridgeToken } = registry.register({ name: "mini", code, capabilities: ["hermes"] });
  registry.touch(bridgeId);
  return { registry, bridgeId, bridgeToken };
}

function resetBridgeData(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const file of ["bridges.json", "bridge-jobs.json"]) {
    const path = join(DATA_DIR, file);
    if (existsSync(path)) rmSync(path);
  }
}

describe("typed Hermes bridge transport", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("requires explicit hermes capability before enqueue", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "shell-only", code, capabilities: ["shell"] });
    expect(() => registry.enqueueHermesDiscover(bridgeId)).toThrow(/hermes capability/);
  });

  it("discovers Hermes status through scrubbed bridge stdout only", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge();
    const promise = discoverHermesOnBridge(registry, { name: "mini" });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("hermes-discover");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({
        kind: "hermes-discover",
        body: {
          state: "available",
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
          },
          profiles: [{
            profile: "default",
            handle: "hermes",
            displayName: "Hermes",
            description: "Remote assistant",
            canonicalChat: "absent",
            availability: "available",
          }],
        },
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    const resolved = await promise;
    expect(resolved).toMatchObject({
      bridgeName: "mini",
      discovery: {
        state: "available",
        profiles: [expect.objectContaining({ profile: "default", canonicalChat: "absent" })],
      },
    });
    const payload = encodeHermesBridgeResult({
      kind: "hermes-discover",
      body: resolved.discovery,
    });
    expect(payload).not.toMatch(/session|jsonrpc|HERMES_HOME|\/Users\//i);
    vi.useRealTimers();
  });

  it("adopts canonical chat before mint through ensure-canonical job", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge();
    const promise = ensureCanonicalHermesOnBridge(registry, "default", { bridgeId });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("hermes-ensure-canonical");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({
        kind: "hermes-ensure-canonical",
        body: { state: "present", adopted: true },
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toMatchObject({
      canonical: { state: "present", adopted: true },
    });
    vi.useRealTimers();
  });

  it("returns bounded scrubbed events for send and supports interrupt jobs", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge();
    const sendPromise = sendHermesOnBridge(registry, {
      profile: "default",
      text: "hello",
      threadId: "thread-1",
      turnId: "turn-1",
    }, { bridgeId });
    await vi.advanceTimersByTimeAsync(500);
    const [sendJob] = registry.pollJobs(bridgeId);
    registry.storeResult({
      jobId: sendJob!.id,
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
      generation: sendJob!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(sendPromise).resolves.toMatchObject({ send: { ok: true, events: [expect.objectContaining({ type: "turn.completed" })] } });

    const interruptPromise = interruptHermesOnBridge(registry, { profile: "default", turnId: "turn-1" }, { bridgeId });
    await vi.advanceTimersByTimeAsync(500);
    const [interruptJob] = registry.pollJobs(bridgeId);
    expect(interruptJob?.kind).toBe("hermes-interrupt");
    registry.storeResult({
      jobId: interruptJob!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({ kind: "hermes-interrupt", body: { ok: true } }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: interruptJob!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(interruptPromise).resolves.toMatchObject({ interrupt: { ok: true } });
    vi.useRealTimers();
  });

  it("fails closed when no online bridge advertises hermes", async () => {
    const registry = new BridgeRegistry();
    await expect(discoverHermesOnBridge(registry)).rejects.toBeInstanceOf(HermesBridgeUnavailableError);
  });

  it("rejects forbidden bridge stdout instead of leaking secrets", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedHermesBridge();
    const promise = discoverHermesOnBridge(registry, { bridgeId });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: JSON.stringify({ kind: "hermes-discover", body: { HERMES_HOME: "/secret" } }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).rejects.toMatchObject({ code: "malformed_response" });
    vi.useRealTimers();
  });

  it("rejects invalid profile strings at enqueue", () => {
    const { registry, bridgeId } = pairedHermesBridge();
    expect(() => registry.enqueueHermesSend(bridgeId, {
      profile: "../escape",
      text: "hello",
      threadId: "thread-1",
      turnId: "turn-1",
    })).toThrow(/invalid hermes profile/i);
    expect(() => registry.enqueueHermesEnsureCanonical(bridgeId, "bad profile!")).toThrow(/invalid hermes profile/i);
  });

  it("requires both advertised and granted hermes capability", () => {
    const { registry, bridgeId } = pairedHermesBridge();
    const path = join(DATA_DIR, "bridges.json");
    const store = JSON.parse(readFileSync(path, "utf8")) as {
      bridges: Array<{ id: string; capabilities: string[]; grantedCapabilities: string[] }>;
    };
    const bridge = store.bridges.find((entry) => entry.id === bridgeId);
    expect(bridge).toBeTruthy();
    bridge!.capabilities = ["hermes"];
    bridge!.grantedCapabilities = ["shell"];
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    expect(() => registry.enqueueHermesDiscover(bridgeId)).toThrow(/granted hermes capability/i);
  });
});
