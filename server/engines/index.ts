import type { AppConfig } from "../config.ts";
import type { InstanceConfig, InstanceConfigMap, ProviderInstance, RuntimeEvent } from "../contracts.ts";
import {
  createHermesBotEngine,
  sanitizeHermesChildEnv,
  type HermesBotEngine,
  type HermesBotEngineOptions,
} from "./hermes.ts";
import type { HermesCommCandidate } from "./hermes-comms.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
  type HermesDiscovery,
} from "./contracts.ts";

const DEFAULT_INSTANCE_ID = "hermes";
const DEFAULT_CLI = "hermes";
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface HermesEngineDescription extends HermesDiscovery {
  /** The configured provider instance that owns this internal adapter. */
  instanceId?: string;
}

export interface HermesEngineRegistryOptions {
  /** The normal application config. Only non-secret vbot metadata is read. */
  config?: Pick<AppConfig, "vbot" | "instances">;
  /** A pre-resolved map is useful for tests and keeps config decoding local. */
  instanceConfigs?: InstanceConfigMap;
  /** The normal provider fleet. A missing/shadow Hermes instance is not safe. */
  providerRegistry?: { get(instanceId: string): ProviderInstance | null };
  /** Dependency injection for transport tests; production uses the adapter. */
  createEngine?: (options: HermesBotEngineOptions) => HermesBotEngine;
  /** Receives already-normalized events. The registry never writes a second log. */
  onEvent?: (event: RuntimeEvent, instanceId: string) => void;
  handleToBotId?: () => ReadonlyMap<string, string>;
  onComm?: (candidate: HermesCommCandidate) => void;
  onSubagent?: HermesBotEngineOptions["onSubagent"];
  /** Test-friendly shorthand for the disabled-by-default metadata. */
  enabled?: boolean;
  instanceId?: string;
}

interface RuntimeEntry {
  instanceId: string;
  engine: HermesBotEngine;
  unsubscribe: () => void;
  discovery?: HermesDiscovery;
}

function isSafeInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID_PATTERN.test(value);
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined;
  return value;
}

function safeEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (name && typeof raw === "string") output[name] = raw;
  }
  return output;
}

function rawHermesOptions(entry: InstanceConfig): HermesBotEngineOptions {
  const raw = entry.config;
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    cli: safeString(config.cli) ?? DEFAULT_CLI,
    ...(safeString(config.workspace) ? { cwd: config.workspace as string } : {}),
    // Keep this boundary positive even when tests inject a fake engine. The
    // adapter repeats the allowlist before spawning, but provider credentials
    // should never reach a registry-created dependency in the first place.
    environment: sanitizeHermesChildEnv(safeEnvironment(entry.environment)),
  };
}

function configuredMetadata(options: HermesEngineRegistryOptions): { enabled: boolean; instanceId: string } {
  const metadata = options.config?.vbot?.hermes;
  const instanceId = options.instanceId ?? metadata?.instanceId ?? DEFAULT_INSTANCE_ID;
  return {
    enabled: options.enabled ?? metadata?.enabled === true,
    instanceId: isSafeInstanceId(instanceId) ? instanceId : DEFAULT_INSTANCE_ID,
  };
}

function unavailableDescription(instanceId?: string, reason: HermesDiscovery["reason"] = "state_unavailable"): HermesEngineDescription {
  return {
    state: "unavailable",
    ...(reason ? { reason } : {}),
    ...(instanceId ? { instanceId } : {}),
    capabilities: {
      roster: false,
      canonicalChat: false,
      send: false,
      finalResponse: false,
      events: false,
      stop: false,
      routinesRead: false,
      messageAgent: false,
      groups: false,
      crossMachine: false,
      queueing: false,
      steer: false,
      attachments: false,
      adoptMint: false,
      approvals: false,
      exclusiveSubmit: false,
    },
    profiles: [],
  };
}

/**
 * Separate internal registry for Hermes Bot Chat.
 *
 * Hermes ACP remains a normal ProviderInstance in ProviderRegistry. This
 * registry deliberately does not add another ProviderInstance: it owns only
 * the local TUI adapter and forwards its normalized events to the existing
 * EventBus sink supplied by the server.
 */
export class HermesEngineRegistry {
  private readonly enabled: boolean;
  private readonly selectedInstanceId: string;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly createEngine: (options: HermesBotEngineOptions) => HermesBotEngine;
  private readonly providerRegistry?: HermesEngineRegistryOptions["providerRegistry"];
  private readonly onEvent?: HermesEngineRegistryOptions["onEvent"];
  private readonly handleToBotId?: HermesEngineRegistryOptions["handleToBotId"];
  private readonly onComm?: HermesEngineRegistryOptions["onComm"];
  private readonly onSubagent?: HermesEngineRegistryOptions["onSubagent"];
  private disposed = false;

  constructor(options: HermesEngineRegistryOptions = {}) {
    const metadata = configuredMetadata(options);
    this.enabled = metadata.enabled;
    this.selectedInstanceId = metadata.instanceId;
    this.createEngine = options.createEngine ?? createHermesBotEngine;
    this.providerRegistry = options.providerRegistry;
    this.onEvent = options.onEvent;
    this.handleToBotId = options.handleToBotId;
    this.onComm = options.onComm;
    this.onSubagent = options.onSubagent;
    if (!this.enabled) return;

    const configs = options.instanceConfigs ?? this.configuredInstances(options.config);
    for (const [instanceId, entry] of Object.entries(configs)) {
      if (!isSafeInstanceId(instanceId) || entry.driver !== "hermesAgent" || entry.enabled === false) continue;
      // ProviderRegistry is the source of truth for whether the configured
      // driver decoded and created safely. A shadow has no child to reuse.
      const provider = this.providerRegistry?.get(instanceId);
      if (this.providerRegistry && (!provider || provider.driverKind !== "hermesAgent")) continue;
      let engine: HermesBotEngine;
      try {
        engine = this.createEngine({
          ...rawHermesOptions(entry),
          ...(this.handleToBotId ? { handleToBotId: this.handleToBotId } : {}),
          ...(this.onComm ? { onComm: this.onComm } : {}),
          ...(this.onSubagent ? { onSubagent: this.onSubagent } : {}),
        });
      } catch {
        continue;
      }
      const unsubscribe = engine.onEvent((event) => {
        if (!this.disposed) this.onEvent?.(event, instanceId);
      });
      this.entries.set(instanceId, { instanceId, engine, unsubscribe });
    }
  }

  /** Snapshot the runtime map with the same default-fleet rules as the hub. */
  private configuredInstances(config?: Pick<AppConfig, "vbot" | "instances">): InstanceConfigMap {
    if (config?.instances && Object.keys(config.instances).length > 0) return config.instances;
    return { hermes: { driver: "hermesAgent" } };
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get instanceId(): string {
    return this.selectedInstanceId;
  }

  /** Resolve a bound bot to the selected, configured Hermes runtime. */
  forBinding(binding: HermesBotBinding): HermesBotEngine | null {
    if (this.disposed || !this.enabled || !binding || binding.adapter !== "hermesBot" || binding.canonicalTitle !== "Bot Chat" || binding.bindingVersion !== 1) {
      return null;
    }
    return this.entries.get(this.selectedInstanceId)?.engine ?? null;
  }

  /** Discover once for every configured Hermes runtime, then return the
   * selected runtime's safe projection. */
  async discover(): Promise<HermesEngineDescription> {
    if (this.disposed || !this.enabled) return unavailableDescription(this.selectedInstanceId);
    if (this.entries.size === 0) return unavailableDescription(this.selectedInstanceId);
    await Promise.all([...this.entries.values()].map(async (entry) => {
      try {
        entry.discovery = await entry.engine.discover();
      } catch (error) {
        const code = error instanceof HermesEngineError ? error.code : "state_unavailable";
        const reason = [
          "missing_cli",
          "invalid_credentials",
          "gateway_unavailable",
          "state_unavailable",
          "malformed_response",
          "timeout",
        ].includes(code)
          ? code as HermesDiscovery["reason"]
          : "state_unavailable";
        entry.discovery = unavailableDescription(entry.instanceId, reason);
      }
    }));
    return this.describe();
  }

  async describe(): Promise<HermesEngineDescription> {
    if (this.disposed || !this.enabled) return unavailableDescription(this.selectedInstanceId);
    const entry = this.entries.get(this.selectedInstanceId);
    if (!entry) return unavailableDescription(this.selectedInstanceId);
    const discovery = entry.discovery;
    if (!discovery) return unavailableDescription(entry.instanceId);
    return {
      ...discovery,
      instanceId: entry.instanceId,
      profiles: discovery.profiles.map((profile) => ({ ...profile })),
      capabilities: { ...discovery.capabilities },
    };
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async ({ engine, unsubscribe }) => {
      try {
        unsubscribe();
      } finally {
        await engine.close();
      }
    }));
  }
}

export function createHermesEngineRegistry(options: HermesEngineRegistryOptions = {}): HermesEngineRegistry {
  return new HermesEngineRegistry(options);
}

export const createHermesRegistry = createHermesEngineRegistry;
