import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { BridgeRegistry, type BridgeJob } from "./bridge-registry.ts";
import { DATA_DIR } from "./config.ts";
import { HermesEngineError } from "./engines/contracts.ts";
import { encodeHermesBridgeResult } from "../shared/bridge-hermes-contract.ts";
import {
  parseHermesSignInInput,
  projectHermesSignInHandoff,
  startHermesSignIn,
  type HermesSignInLaunch,
} from "./hermes-signin.ts";

function resetBridgeData(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const file of ["bridges.json", "bridge-jobs.json"]) {
    const path = join(DATA_DIR, file);
    if (existsSync(path)) rmSync(path);
  }
}

function pairedHermesBridge(name = "Mac mini") {
  const registry = new BridgeRegistry();
  const { code } = registry.startPairing();
  const { bridgeId } = registry.register({ name, code, capabilities: ["hermes"] });
  registry.touch(bridgeId);
  return { registry, bridgeId };
}

function ageBridge(bridgeId: string, lastSeenAt: number): void {
  const path = join(DATA_DIR, "bridges.json");
  const store = JSON.parse(readFileSync(path, "utf8")) as {
    bridges: Array<{ id: string; lastSeenAt: number }>;
  };
  const bridge = store.bridges.find((entry) => entry.id === bridgeId);
  if (!bridge) throw new Error("missing bridge fixture");
  bridge.lastSeenAt = lastSeenAt;
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function waitForBridgeJob(
  registry: BridgeRegistry,
  bridgeId: string,
  kind: string,
  timeoutMs = 2_000,
): Promise<BridgeJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    registry.touch(bridgeId);
    const [job] = registry.pollJobs(bridgeId);
    if (job?.kind === kind) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${kind}`);
}

const DIAGNOSTIC_LEAK = /sk-|Bearer |HERMES_HOME|token|secret|\/Users\/|stderr/i;
const WORKTREE_STACK = [
  "HermesEngineError: Hermes gateway is unavailable",
  "    at startHermesSignIn (/Users/Vincent/Github/.worktrees/vbot-hermes-verify-0902/server/hermes-signin.ts:83:13)",
  "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
].join("\n");

function diagnosticSurface(value: unknown): string {
  const parts: string[] = [];
  if (typeof value === "string") return value;
  try {
    parts.push(JSON.stringify(value) ?? "null");
  } catch {
    parts.push("");
  }
  if (!value || typeof value !== "object") return parts.join(" ");
  const record = value as Record<string, unknown>;
  for (const key of ["name", "message", "code"]) {
    if (record[key] !== undefined) parts.push(String(record[key]));
  }
  for (const [key, entry] of Object.entries(record)) {
    if (key === "stack") continue;
    parts.push(key);
    if (entry === undefined) continue;
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      parts.push(String(entry));
      continue;
    }
    try {
      parts.push(JSON.stringify(entry) ?? "");
    } catch {
      /* ignore non-JSON enumerable values */
    }
  }
  return parts.join(" ");
}

function expectNoDiagnostics(value: unknown): void {
  expect(diagnosticSurface(value)).not.toMatch(DIAGNOSTIC_LEAK);
}

describe("Hermes sign-in diagnostic assertions", () => {
  it("does not treat V8 stack frames from a /Users worktree as a leak", () => {
    const error = new HermesEngineError("gateway_unavailable");
    error.stack = WORKTREE_STACK;
    expect(error).toMatchObject({ code: "gateway_unavailable" });
    expectNoDiagnostics(error);
  });

  it("still flags secret-shaped fields in name, message, enumerable properties, and JSON", () => {
    const leaked = new HermesEngineError("gateway_unavailable");
    leaked.stack = WORKTREE_STACK;
    Object.defineProperty(leaked, "message", {
      value: "HERMES_HOME=/Users/Vincent/.hermes token=sk-secret",
      configurable: true,
    });
    expect(() => expectNoDiagnostics(leaked)).toThrow(/HERMES_HOME|sk-secret|\/Users\//i);

    const enumerable = new HermesEngineError("gateway_unavailable");
    enumerable.stack = WORKTREE_STACK;
    Object.assign(enumerable, { stderr: "Bearer secret" });
    expect(() => expectNoDiagnostics(enumerable)).toThrow(/Bearer |stderr|secret/i);

    expect(() => expectNoDiagnostics({
      kind: "terminal",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
      stdout: "token=sk-secret",
    })).toThrow(/sk-|token/i);
  });
});

describe("Hermes sign-in handoff", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("starts Hermes setup on the selected computer without capturing output", async () => {
    const launches: HermesSignInLaunch[] = [];
    const handoff = await startHermesSignIn({
      placement: { kind: "local", profile: "default" },
      localComputerName: "Studio",
      launch: async (command) => {
        launches.push(command);
        return { ok: true, kind: "terminal" };
      },
    });
    expect(handoff).toEqual({
      kind: "terminal",
      computerName: "Studio",
      message: "Complete sign-in on Studio, then try again.",
    });
    expect(launches).toEqual([expect.objectContaining({
      kind: "terminal",
      argv: ["setup"],
    })]);
    expectNoDiagnostics({ handoff, launches });
  });

  it("starts Hermes setup on an online named bridge without capturing output", async () => {
    const { registry, bridgeId } = pairedHermesBridge("Mac mini");
    const launches: HermesSignInLaunch[] = [];
    const promise = startHermesSignIn({
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
      bridgeRegistry: registry,
      launch: async (command) => {
        launches.push(command);
        return { ok: true, kind: "terminal" };
      },
    });
    const job = await waitForBridgeJob(registry, bridgeId, "hermes-signin");
    expect(job).toMatchObject({
      kind: "hermes-signin",
      payload: { argv: ["setup"] },
    });
    expectNoDiagnostics(job);
    expect(launches).toEqual([]);
    registry.storeResult({
      jobId: job.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({
        kind: "hermes-signin",
        body: { kind: "terminal" },
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job.generation,
    });
    const handoff = await promise;
    expect(handoff).toEqual({
      kind: "terminal",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
    });
    expectNoDiagnostics(handoff);
  });

  it("surfaces a browser handoff when the selected bridge starts Hermes sign-in", async () => {
    const { registry, bridgeId } = pairedHermesBridge("Mac mini");
    const promise = startHermesSignIn({
      placement: { kind: "bridge", bridge: "mac mini", profile: "default" },
      bridgeRegistry: registry,
    });
    const job = await waitForBridgeJob(registry, bridgeId, "hermes-signin");
    expect(job).toMatchObject({
      kind: "hermes-signin",
      payload: { argv: ["setup"] },
    });
    registry.storeResult({
      jobId: job.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeHermesBridgeResult({
        kind: "hermes-signin",
        body: { kind: "browser" },
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job.generation,
    });
    await expect(promise).resolves.toEqual({
      kind: "browser",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
    });
  });

  it("fails closed without leaking diagnostics when the selected bridge is offline", async () => {
    const { registry, bridgeId } = pairedHermesBridge("Mac mini");
    ageBridge(bridgeId, Date.now() - 60_000);
    let launched = false;
    await expect(startHermesSignIn({
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
      bridgeRegistry: registry,
      launch: async () => {
        launched = true;
        return { ok: true, kind: "terminal" };
      },
    })).rejects.toMatchObject({ code: "gateway_unavailable" });
    expect(launched).toBe(false);
    expect(registry.pollJobs(bridgeId)).toEqual([]);
  });

  it("fails closed without leaking diagnostics when the selected bridge is missing", async () => {
    const registry = new BridgeRegistry();
    let launched = false;
    try {
      await startHermesSignIn({
        placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
        bridgeRegistry: registry,
        launch: async () => {
          launched = true;
          return { ok: true, kind: "terminal" };
        },
      });
      throw new Error("expected missing bridge sign-in to fail closed");
    } catch (error) {
      expect(error).toMatchObject({ code: "gateway_unavailable" });
      expectNoDiagnostics(error);
    }
    expect(launched).toBe(false);
  });

  it("fails closed without leaking diagnostics when the bridge job fails", async () => {
    const { registry, bridgeId } = pairedHermesBridge("Mac mini");
    const promise = startHermesSignIn({
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
      bridgeRegistry: registry,
    });
    const job = await waitForBridgeJob(registry, bridgeId, "hermes-signin");
    registry.storeResult({
      jobId: job.id,
      bridgeId,
      exitCode: 1,
      stdout: "token=sk-secret",
      stderr: "HERMES_HOME=/Users/Vincent/.hermes Bearer secret",
      truncated: false,
      finishedAt: Date.now(),
      generation: job.generation,
    });
    try {
      await promise;
      throw new Error("expected failed bridge sign-in to fail closed");
    } catch (error) {
      expect(error).toMatchObject({ code: "gateway_unavailable" });
      expectNoDiagnostics(error);
    }
  });

  it("fails closed without leaking diagnostics when launch is unavailable", async () => {
    await expect(startHermesSignIn({
      placement: { kind: "local", profile: "default" },
      launch: async () => ({ ok: false }),
    })).rejects.toMatchObject({ code: "gateway_unavailable" });
  });

  it("projects only safe handoff fields", () => {
    const projected = projectHermesSignInHandoff({
      kind: "terminal",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
      stdout: "token=sk-secret HERMES_HOME=/Users/Vincent/.hermes",
    });
    expect(projected).toEqual({
      kind: "terminal",
      computerName: "Mac mini",
      message: "Complete sign-in on Mac mini, then try again.",
    });
    expectNoDiagnostics(projected);
  });

  it("accepts only a placement for sign-in and never extra secret fields", () => {
    expect(parseHermesSignInInput({
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
    })).toEqual({
      ok: true,
      placement: { kind: "bridge", bridge: "mac mini", profile: "default" },
    });
    expect(parseHermesSignInInput({ token: "sk-secret" })).toMatchObject({ ok: false });
    expect(parseHermesSignInInput({
      placement: { kind: "local", profile: "default" },
      stdout: "token=sk-secret",
    })).toMatchObject({ ok: false });
  });
});
