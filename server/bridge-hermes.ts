import type {
  BridgeJobResult,
  BridgeRegistry,
  HermesBridgeInterruptPayload,
  HermesBridgeSendPayload,
} from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";
import { resolveBridge } from "./bridge-exec.ts";
import {
  encodeHermesBridgeResult,
  parseHermesBridgeResult,
  type HermesBridgeDiscoveryWire,
  type HermesBridgeEnsureCanonicalWire,
  type HermesBridgeInterruptWire,
  type HermesBridgeResultWire,
  type HermesBridgeSendWire,
} from "../shared/bridge-hermes-contract.ts";
import type { HermesFailureCode } from "./engines/contracts.ts";

export class HermesBridgeUnavailableError extends Error {
  readonly code: HermesFailureCode | "bridge_unavailable";

  constructor(code: HermesFailureCode | "bridge_unavailable", message: string) {
    super(message);
    this.name = "HermesBridgeUnavailableError";
    this.code = code;
  }
}

function parseHermesJobResult(result: BridgeJobResult): HermesBridgeResultWire {
  if (result.exitCode !== 0) {
    throw new HermesBridgeUnavailableError(
      "gateway_unavailable",
      result.stderr.trim() || result.stdout.trim() || "bridge Hermes job failed",
    );
  }
  try {
    return parseHermesBridgeResult(result.stdout);
  } catch (error) {
    throw new HermesBridgeUnavailableError(
      "malformed_response",
      error instanceof Error ? error.message : "bridge Hermes job returned invalid payload",
    );
  }
}

async function runHermesBridgeJob(
  registry: BridgeRegistry,
  opts: {
    bridgeId?: string;
    name?: string;
    enqueue: (bridgeId: string) => { id: string };
    timeoutMs: number;
  },
): Promise<{ wire: HermesBridgeResultWire; bridgeName: string }> {
  const bridge = resolveBridge(registry, { bridgeId: opts.bridgeId, name: opts.name, capability: "hermes" });
  if (!bridge) {
    throw new HermesBridgeUnavailableError("bridge_unavailable", "no online bridge with hermes matched");
  }
  const job = opts.enqueue(bridge.id);
  const result = await waitForBridgeJobResult(registry, job.id, opts.timeoutMs, bridge.name);
  return { wire: parseHermesJobResult(result), bridgeName: bridge.name };
}

export async function discoverHermesOnBridge(
  registry: BridgeRegistry,
  opts: { bridgeId?: string; name?: string; timeoutMs?: number } = {},
): Promise<{ discovery: HermesBridgeDiscoveryWire; bridgeName: string }> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const { wire, bridgeName } = await runHermesBridgeJob(registry, {
    bridgeId: opts.bridgeId,
    name: opts.name,
    timeoutMs,
    enqueue: (bridgeId) => registry.enqueueHermesDiscover(bridgeId, timeoutMs),
  });
  if (wire.kind !== "hermes-discover") {
    throw new HermesBridgeUnavailableError("malformed_response", "bridge Hermes discovery returned wrong kind");
  }
  return { discovery: wire.body, bridgeName };
}

export async function ensureCanonicalHermesOnBridge(
  registry: BridgeRegistry,
  profile: string,
  opts: { bridgeId?: string; name?: string; timeoutMs?: number } = {},
): Promise<{ canonical: HermesBridgeEnsureCanonicalWire; bridgeName: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const { wire, bridgeName } = await runHermesBridgeJob(registry, {
    bridgeId: opts.bridgeId,
    name: opts.name,
    timeoutMs,
    enqueue: (bridgeId) => registry.enqueueHermesEnsureCanonical(bridgeId, profile, timeoutMs),
  });
  if (wire.kind !== "hermes-ensure-canonical") {
    throw new HermesBridgeUnavailableError("malformed_response", "bridge Hermes canonical job returned wrong kind");
  }
  return { canonical: wire.body, bridgeName };
}

export async function sendHermesOnBridge(
  registry: BridgeRegistry,
  payload: HermesBridgeSendPayload,
  opts: { bridgeId?: string; name?: string; timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<{ send: HermesBridgeSendWire; bridgeName: string }> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const { wire, bridgeName } = await runHermesBridgeJob(registry, {
    bridgeId: opts.bridgeId,
    name: opts.name,
    timeoutMs,
    enqueue: (bridgeId) => registry.enqueueHermesSend(bridgeId, payload, timeoutMs, {
      idempotencyKey: opts.idempotencyKey,
    }),
  });
  if (wire.kind !== "hermes-send") {
    throw new HermesBridgeUnavailableError("malformed_response", "bridge Hermes send job returned wrong kind");
  }
  return { send: wire.body, bridgeName };
}

export async function interruptHermesOnBridge(
  registry: BridgeRegistry,
  payload: HermesBridgeInterruptPayload,
  opts: { bridgeId?: string; name?: string; timeoutMs?: number } = {},
): Promise<{ interrupt: HermesBridgeInterruptWire; bridgeName: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const { wire, bridgeName } = await runHermesBridgeJob(registry, {
    bridgeId: opts.bridgeId,
    name: opts.name,
    timeoutMs,
    enqueue: (bridgeId) => registry.enqueueHermesInterrupt(bridgeId, payload, timeoutMs),
  });
  if (wire.kind !== "hermes-interrupt") {
    throw new HermesBridgeUnavailableError("malformed_response", "bridge Hermes interrupt job returned wrong kind");
  }
  return { interrupt: wire.body, bridgeName };
}

export function encodeBridgeHermesFixtureResult(result: HermesBridgeResultWire): BridgeJobResult {
  return {
    jobId: "fixture",
    bridgeId: "fixture",
    exitCode: 0,
    stdout: encodeHermesBridgeResult(result),
    stderr: "",
    truncated: false,
    finishedAt: Date.now(),
  };
}
