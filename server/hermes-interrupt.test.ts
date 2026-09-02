import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchHermesInterrupt, type HermesInterruptDependencies } from "./hermes-interrupt.ts";
import { RoutineManager } from "./routines.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { encodeHermesBridgeResult } from "../shared/bridge-hermes-contract.ts";

const binding = {
  adapter: "hermesBot" as const,
  profile: "default",
  canonicalTitle: "Bot Chat" as const,
  bindingVersion: 1 as const,
};

const tempDirs: string[] = [];

function harness(state: "available" | "disabled" | "unreadable") {
  let hermesCalls = 0;
  let providerCalls = 0;
  const engine = {
    interrupt: async () => {
      hermesCalls += 1;
    },
  };
  const dependencies: HermesInterruptDependencies = {
    loadBindings: () => state === "unreadable"
      ? { state: "unavailable", code: "state_unavailable", message: "Hermes state is unavailable" }
      : { state: "available", value: new Map([[
        "bot-1",
        binding,
      ]]) },
    loadBridgeBindings: () => ({ state: "available", value: new Map() }),
    hermesRegistry: {
      forBinding: () => state === "disabled" ? null : engine,
    },
    resolveProvider: () => ({
      adapter: {
        interruptTurn: async () => {
          providerCalls += 1;
        },
      },
    }),
  };
  return {
    dependencies,
    dispatch: (threadId = "thread-1") => dispatchHermesInterrupt(
      { botId: "bot-1", threadId },
      dependencies,
    ),
    calls: () => ({ hermes: hermesCalls, provider: providerCalls }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("binding-aware interrupt dispatch", () => {
  it.each([
    ["available", 1, 0],
    ["disabled", 0, 0],
    ["unreadable", 0, 0],
  ] as const)("routine cancellation stays on the Hermes boundary when %s", async (state, hermes, provider) => {
    const h = harness(state);
    const dir = mkdtempSync(join(tmpdir(), "omb-hermes-interrupt-routine-"));
    tempDirs.push(dir);
    let now = 0;
    const manager = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => now,
      botState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }),
      startTurn: async () => undefined,
      interruptTurn: async (_botId, threadId) => {
        await h.dispatch(threadId);
      },
    });
    const routine = manager.create({
      name: "Bound Hermes routine",
      prompt: "do work",
      botId: "bot-1",
      schedule: { type: "once", at: 100 },
    });
    now = routine.nextRunAt!;
    await manager.tick();
    const run = manager.activeRunForBot("bot-1");
    expect(run?.threadId).toBe("thread-1");
    await manager.cancelRun(run!.id);
    expect(h.calls()).toEqual({ hermes, provider });
    expect(manager.listRuns()[0]).toMatchObject({ status: "cancelled" });
  });

  it("routes bridge-bound bots through interruptHermesOnBridge", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "mini", code, capabilities: ["hermes"] });
    registry.touch(bridgeId);

    let providerCalls = 0;
    const dependencies: HermesInterruptDependencies = {
      loadBindings: () => ({ state: "available", value: new Map() }),
      loadBridgeBindings: () => ({
        state: "available",
        value: new Map([["bot-bridge", { bridgeId, profile: "default", bindingVersion: 1 }]]),
      }),
      bridgeRegistry: registry,
      hermesRegistry: { forBinding: () => null },
      resolveProvider: () => ({
        adapter: {
          interruptTurn: async () => {
            providerCalls += 1;
          },
        },
      }),
    };

    vi.useFakeTimers();
    const promise = dispatchHermesInterrupt({ botId: "bot-bridge", threadId: "thread-1" }, dependencies);
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
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
    const route = await promise;
    vi.useRealTimers();

    expect(route).toBe("hermes-bridge");
    expect(providerCalls).toBe(0);
    expect(job?.kind).toBe("hermes-interrupt");
  });

  it("keeps an unbound bot on its generic provider", async () => {
    const h = harness("available");
    h.dependencies.loadBindings = () => ({ state: "available", value: new Map() });
    await h.dispatch();
    expect(h.calls()).toEqual({ hermes: 0, provider: 1 });
  });

  it.each([
    ["available", 1, 0],
    ["disabled", 0, 0],
    ["unreadable", 0, 0],
  ] as const)("watchdog stall stays on the Hermes boundary when %s", async (state, hermes, provider) => {
    const h = harness(state);
    let now = 0;
    const dog = new TurnWatchdog({
      stallMs: 10,
      checkMs: 60_000,
      now: () => now,
      onStall: (turn) => {
        void h.dispatch(turn.threadId).catch(() => {});
      },
    });
    dog.watch("thread-1", "bot-1");
    now = 11;
    dog.sweep();
    await Promise.resolve();
    expect(h.calls()).toEqual({ hermes, provider });
    expect(dog.watching("thread-1")).toBe(false);
  });
});
