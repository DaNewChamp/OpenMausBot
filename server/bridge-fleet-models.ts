import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { BridgeJobResult, BridgeRegistry } from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";
import { resolveBridge } from "./bridge-exec.ts";
import { DATA_DIR } from "./data-dir.ts";
import { HermesEngineError } from "./engines/contracts.ts";
import {
  DEFAULT_FLEET_DISCOVERY_INTERVAL_MS,
  FLEET_MODEL_PREFIX,
  fleetModelId,
  machineSlug,
  parseFleetChatResult,
  parseFleetModelId,
  parseLocalModelsPayload,
  type FleetChatMessage,
  type LocalModelServer,
  type LocalModelsPayload,
} from "../shared/bridge-fleet-contract.ts";
import { HermesBridgeUnavailableError } from "./bridge-hermes.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { replayScrubbedHermesEvents } from "./hermes-bridge-integration.ts";

export interface StoredFleetCatalog {
  bridgeId: string;
  name: string;
  slug: string;
  intervalMs: number;
  lastSeenAt: number;
  servers: LocalModelServer[];
}

export interface FleetModelApiRow {
  id: string;
  machine: string;
  label: string;
  server: LocalModelServer["kind"];
  models: Array<{ id: string; name: string }>;
}

export interface FleetModelLookup {
  bridgeId: string;
  name: string;
  slug: string;
  server: LocalModelServer;
  modelId: string;
  modelName: string;
}

interface FleetCatalogFile {
  catalogs: StoredFleetCatalog[];
}

const lastKnown = new Map<string, StoredFleetCatalog>();
let loaded = false;

function catalogPath(): string {
  return join(DATA_DIR, "fleet-models.json");
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    catalogPath(),
    `${JSON.stringify({ catalogs: [...lastKnown.values()] } satisfies FleetCatalogFile, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(catalogPath())) return;
    const parsed = JSON.parse(readFileSync(catalogPath(), "utf8")) as FleetCatalogFile;
    for (const row of parsed.catalogs ?? []) {
      if (!row || typeof row.bridgeId !== "string" || typeof row.name !== "string") continue;
      if (!Array.isArray(row.servers)) continue;
      lastKnown.set(row.bridgeId, {
        bridgeId: row.bridgeId,
        name: row.name,
        slug: typeof row.slug === "string" && row.slug ? row.slug : machineSlug(row.name),
        intervalMs: typeof row.intervalMs === "number" && row.intervalMs > 0
          ? row.intervalMs
          : DEFAULT_FLEET_DISCOVERY_INTERVAL_MS,
        lastSeenAt: typeof row.lastSeenAt === "number" ? row.lastSeenAt : 0,
        servers: row.servers,
      });
    }
  } catch {
    /* keep empty — a corrupt file is treated as a cold start */
  }
}

function uniqueSlug(name: string, bridgeId: string): string {
  const base = machineSlug(name);
  const taken = [...lastKnown.values()].some((row) => row.bridgeId !== bridgeId && row.slug === base);
  if (!taken) return base;
  const suffix = bridgeId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return suffix ? `${base}-${suffix}` : `${base}-bridge`;
}

function staleWindowMs(intervalMs: number): number {
  return Math.max(intervalMs, 1_000) * 2;
}

function pruneStale(now: number): boolean {
  let changed = false;
  for (const [bridgeId, row] of lastKnown) {
    if (now - row.lastSeenAt > staleWindowMs(row.intervalMs)) {
      lastKnown.delete(bridgeId);
      changed = true;
    }
  }
  return changed;
}

export function resetFleetModelCatalogForTests(): void {
  lastKnown.clear();
  loaded = true;
  try {
    if (existsSync(catalogPath())) rmSync(catalogPath());
  } catch {
    /* test isolation */
  }
}

export function unloadFleetModelCatalogForTests(): void {
  lastKnown.clear();
  loaded = false;
}

export function ingestLocalModelCatalog(
  bridgeId: string,
  raw: unknown,
  opts: { name: string; now?: number; intervalMs?: number },
): LocalModelsPayload | null {
  load();
  const parsed = parseLocalModelsPayload(raw);
  if (!parsed) return lastKnown.get(bridgeId) ? { kind: "local-models", servers: lastKnown.get(bridgeId)!.servers } : null;
  const now = opts.now ?? Date.now();
  const name = opts.name.trim() || "bridge";
  lastKnown.set(bridgeId, {
    bridgeId,
    name,
    slug: uniqueSlug(name, bridgeId),
    intervalMs: opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_FLEET_DISCOVERY_INTERVAL_MS,
    lastSeenAt: now,
    servers: parsed.servers,
  });
  pruneStale(now);
  persist();
  return parsed;
}

export function lastKnownLocalModelsFor(bridgeId: string): StoredFleetCatalog | null {
  load();
  return lastKnown.get(bridgeId) ?? null;
}

export function listAdvertisedFleetModels(opts: { now?: number } = {}): FleetModelApiRow[] {
  load();
  const now = opts.now ?? Date.now();
  if (pruneStale(now)) persist();
  const rows: FleetModelApiRow[] = [];
  const catalogs = [...lastKnown.values()].sort((a, b) => a.name.localeCompare(b.name) || a.bridgeId.localeCompare(b.bridgeId));
  for (const catalog of catalogs) {
    for (const server of catalog.servers) {
      for (const model of server.models) {
        rows.push({
          id: fleetModelId(catalog.slug, model.id),
          machine: catalog.name,
          label: model.name,
          server: server.kind,
          models: [{ id: model.id, name: model.name }],
        });
      }
    }
  }
  return rows;
}

/** One picker instance per advertised machine so Create bot / model
 * selection lists fleet GPUs next to Cloud and Local engines. */
export function advertisedFleetInstances(opts: { now?: number } = {}) {
  const groups = new Map<string, {
    instanceId: string;
    driverKind: "fleet";
    displayName: string;
    snapshot: { state: "available"; version: string | null };
    models: { default: string; options: Array<{ id: string; label: string }> };
    capabilities: { computerMcp: false; agentsMcp: false; localComputerMcp: false };
  }>();
  for (const row of listAdvertisedFleetModels(opts)) {
    const parsed = parseFleetModelId(row.id);
    if (!parsed) continue;
    const instanceId = `${FLEET_MODEL_PREFIX}${parsed.machineSlug}`;
    const option = { id: row.id, label: row.label || parsed.modelId };
    const existing = groups.get(instanceId);
    if (existing) {
      if (!existing.models.options.some((model) => model.id === option.id)) {
        existing.models.options.push(option);
      }
      continue;
    }
    groups.set(instanceId, {
      instanceId,
      driverKind: "fleet",
      displayName: row.machine || parsed.machineSlug,
      snapshot: { state: "available", version: row.server },
      models: { default: option.id, options: [option] },
      capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
    });
  }
  return [...groups.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName) || a.instanceId.localeCompare(b.instanceId)
  );
}

export function lookupFleetModel(id: string, opts: { now?: number } = {}): FleetModelLookup | null {
  const parsed = parseFleetModelId(id);
  if (!parsed) return null;
  load();
  const now = opts.now ?? Date.now();
  if (pruneStale(now)) persist();
  const matches = [...lastKnown.values()].filter((row) => row.slug === parsed.machineSlug);
  matches.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  for (const catalog of matches) {
    for (const server of catalog.servers) {
      const model = server.models.find((entry) => entry.id === parsed.modelId);
      if (!model) continue;
      return {
        bridgeId: catalog.bridgeId,
        name: catalog.name,
        slug: catalog.slug,
        server,
        modelId: model.id,
        modelName: model.name,
      };
    }
  }
  return null;
}

function parseFleetJobResult(result: BridgeJobResult) {
  if (result.exitCode !== 0) {
    throw new HermesBridgeUnavailableError(
      "gateway_unavailable",
      result.stderr.trim() || result.stdout.trim() || "bridge fleet chat job failed",
    );
  }
  try {
    return parseFleetChatResult(result.stdout);
  } catch (error) {
    throw new HermesBridgeUnavailableError(
      "malformed_response",
      error instanceof Error ? error.message : "bridge fleet chat job returned invalid payload",
    );
  }
}

export async function sendFleetChatOnBridge(
  registry: BridgeRegistry,
  payload: {
    bridgeId?: string;
    name?: string;
    baseUrl: string;
    model: string;
    messages: FleetChatMessage[];
    threadId: string;
    turnId: string;
  },
  opts: { timeoutMs?: number } = {},
): Promise<{ send: { ok: boolean; turnId: string; events: ReturnType<typeof parseFleetChatResult>["body"]["events"] }; bridgeName: string }> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const bridge = resolveBridge(registry, { bridgeId: payload.bridgeId, name: payload.name });
  if (!bridge) {
    throw new HermesBridgeUnavailableError("bridge_unavailable", "no online bridge matched");
  }
  const job = registry.enqueueFleetChat(bridge.id, {
    baseUrl: payload.baseUrl,
    model: payload.model,
    messages: payload.messages,
    threadId: payload.threadId,
    turnId: payload.turnId,
  }, timeoutMs);
  const result = await waitForBridgeJobResult(registry, job.id, timeoutMs, bridge.name);
  const wire = parseFleetJobResult(result);
  return { send: wire.body, bridgeName: bridge.name };
}

export async function dispatchFleetModelTurn(options: {
  registry: BridgeRegistry;
  model: string;
  messages: FleetChatMessage[];
  threadId: string;
  turnId: string;
  publishEvent: (event: RuntimeEvent) => void;
  instanceId?: string;
}): Promise<void> {
  const found = lookupFleetModel(options.model);
  if (!found) throw new HermesEngineError("gateway_unavailable");
  const online = resolveBridge(options.registry, { bridgeId: found.bridgeId });
  if (!online) throw new HermesEngineError("gateway_unavailable");
  const { send } = await sendFleetChatOnBridge(options.registry, {
    bridgeId: found.bridgeId,
    baseUrl: found.server.baseUrl,
    model: found.modelId,
    messages: options.messages,
    threadId: options.threadId,
    turnId: options.turnId,
  });
  if (!send.ok) throw new HermesEngineError("upstream_error");
  replayScrubbedHermesEvents(send.events, options.instanceId ?? "fleet", options.publishEvent);
}
