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
  type HermesBridgeSignInKind,
} from "../shared/bridge-hermes-contract.ts";
import type { HermesFailureCode } from "./engines/contracts.ts";
import { rememberHermesBridgeAlias, rememberHermesEndpoint } from "./bot-runtime-rebind.ts";

const lastKnownHermesEndpoints = new Map<string, HermesEndpointDescriptor[]>();

export interface HermesEndpointDescriptor {
  endpointId: string;
  bridgeId: string;
  profile?: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  capabilityRevision: string;
  status: "available" | "unavailable" | "unreadable";
}

const ENDPOINT_ID = /^bridge:[A-Za-z0-9._-]+:[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isDescriptor(value: unknown): value is HermesEndpointDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.endpointId !== "string" || !ENDPOINT_ID.test(record.endpointId)) return false;
  if (typeof record.bridgeId !== "string" || record.bridgeId.length === 0) return false;
  if (typeof record.displayName !== "string" || record.displayName.length === 0 || record.displayName.length > 160) return false;
  if (record.status !== "available" && record.status !== "unavailable" && record.status !== "unreadable") return false;
  if (typeof record.capabilityRevision !== "string" || !/^[a-f0-9]{16,64}$/.test(record.capabilityRevision)) return false;
  if (record.profile !== undefined && (typeof record.profile !== "string" || !PROFILE.test(record.profile))) return false;
  if (!record.capabilities || typeof record.capabilities !== "object" || Array.isArray(record.capabilities)) return false;
  for (const [key, flag] of Object.entries(record.capabilities as Record<string, unknown>)) {
    if (typeof key !== "string" || typeof flag !== "boolean") return false;
    if (/token|secret|password|path|session/i.test(key)) return false;
  }
  const json = JSON.stringify(record);
  if (/token|HERMES_HOME|\/Users\/|sk-|session-/i.test(json)) return false;
  return true;
}

export function ingestHermesEndpointDescriptors(bridgeId: string, raw: unknown): HermesEndpointDescriptor[] {
  if (!Array.isArray(raw)) return lastKnownHermesEndpoints.get(bridgeId) ?? [];
  const parsed = raw.filter(isDescriptor).filter((row) => row.bridgeId === bridgeId);
  if (parsed.some((row) => row.status === "unreadable" || row.status === "unavailable")) {
    lastKnownHermesEndpoints.delete(bridgeId);
    return parsed;
  }
  lastKnownHermesEndpoints.set(bridgeId, parsed);
  for (const row of parsed) {
    if (row.status === "available" && row.profile) {
      rememberHermesEndpoint(row.endpointId, row.capabilityRevision);
      const displayComputer = row.displayName.split(" / ")[0]?.trim();
      if (displayComputer) {
        rememberHermesBridgeAlias(displayComputer, row.bridgeId);
        const aliasId = `bridge:${displayComputer.toLowerCase()}:${row.profile.toLowerCase()}`;
        if (aliasId !== row.endpointId) {
          rememberHermesEndpoint(aliasId, row.capabilityRevision);
        }
      }
    }
  }
  return parsed;
}

export function lastKnownHermesEndpointsFor(bridgeId: string): HermesEndpointDescriptor[] {
  return lastKnownHermesEndpoints.get(bridgeId) ?? [];
}

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

export async function startHermesSignInOnBridge(
  registry: BridgeRegistry,
  opts: { bridgeId?: string; name?: string; timeoutMs?: number } = {},
): Promise<{ kind: HermesBridgeSignInKind; bridgeName: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const bridge = resolveBridge(registry, {
    bridgeId: opts.bridgeId,
    name: opts.name,
    capability: "hermes",
  });
  if (!bridge) {
    throw new HermesBridgeUnavailableError("gateway_unavailable", "bridge Hermes sign-in unavailable");
  }
  const job = registry.enqueueHermesSignIn(bridge.id, timeoutMs);
  let result: BridgeJobResult;
  try {
    result = await waitForBridgeJobResult(registry, job.id, timeoutMs, bridge.name);
  } catch {
    throw new HermesBridgeUnavailableError("gateway_unavailable", "bridge Hermes sign-in unavailable");
  }
  if (result.exitCode !== 0) {
    throw new HermesBridgeUnavailableError("gateway_unavailable", "bridge Hermes sign-in unavailable");
  }
  try {
    const wire = parseHermesBridgeResult(result.stdout);
    if (wire.kind !== "hermes-signin") {
      throw new HermesBridgeUnavailableError("gateway_unavailable", "bridge Hermes sign-in unavailable");
    }
    return { kind: wire.body.kind, bridgeName: bridge.name };
  } catch {
    throw new HermesBridgeUnavailableError("gateway_unavailable", "bridge Hermes sign-in unavailable");
  }
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
