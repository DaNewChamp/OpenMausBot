import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

import type { RuntimeEvent } from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import {
  normalizeCanonicalLookup,
  normalizeProfileRowsResult,
  projectHermesCapabilities,
} from "./discovery.ts";
import {
  HermesEngineError,
  type HermesCanonicalChat,
  type HermesCanonicalLookup,
  type HermesCapabilityFlags,
  type HermesDiscovery,
  type HermesFailureCode,
} from "./contracts.ts";

const DEFAULT_CLI = "hermes";
const DEFAULT_TIMEOUTS = {
  initializationMs: 10_000,
  requestMs: 30_000,
  turnMs: 120_000,
  reconnectMs: 10_000,
} as const;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PROFILE_MAX_LENGTH = 64;
const MAX_READY_VERSION_LENGTH = 120;

/** The small part of a ChildProcess used by the injected transport seam. */
export interface HermesProcess {
  stdin?: HermesWritable;
  stdout?: HermesReadable;
  stderr?: HermesReadable;
  on(event: string, listener: (...args: any[]) => void): this;
  once?(event: string, listener: (...args: any[]) => void): this;
  removeListener?(event: string, listener: (...args: any[]) => void): this;
  kill?(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}

export interface HermesWritable {
  writable?: boolean;
  write(chunk: string, callback?: (error?: Error | null) => void): boolean | void;
  end?(): void;
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface HermesReadable {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
}

export type HermesSpawn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => HermesProcess;

export interface HermesClock {
  now?: () => number;
  setTimeout?: (handler: () => void, timeout: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface HermesTimeouts {
  initializationMs: number;
  requestMs: number;
  turnMs: number;
  reconnectMs: number;
}

export interface HermesBotEngineOptions {
  /** Hermes executable name or absolute path. */
  cli?: string;
  /** Launch cwd. This is not sent in an RPC payload. */
  cwd?: string;
  /** Environment additions for Hermes itself. V Bot credentials are removed. */
  environment?: Record<string, string | undefined>;
  /** Alias accepted by callers that use the SPI's terminology. */
  env?: Record<string, string | undefined>;
  spawn?: HermesSpawn;
  clock?: HermesClock;
  timeouts?: Partial<HermesTimeouts>;
}

export interface HermesBotEngine {
  discover(): Promise<HermesDiscovery>;
  resolveCanonical(profile: string): Promise<HermesCanonicalChat>;
  send(input: {
    profile: string;
    text: string;
    model?: string;
    cwd?: string;
    threadId: string;
    turnId: string;
  }): Promise<{ turnId: string }>;
  interrupt(profile: string, turnId?: string): Promise<void>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
}

export interface HermesGatewayEventFrame {
  generation: number;
  params: Record<string, unknown>;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: HermesEngineError) => void;
  timer: unknown;
}

interface GatewayStateChange {
  generation: number;
  kind: "ready" | "closed";
  intentional: boolean;
  payload?: Record<string, unknown>;
}

export interface HermesGatewayClientOptions {
  cli: string;
  cwd?: string;
  environment: NodeJS.ProcessEnv;
  spawn: HermesSpawn;
  clock: Required<HermesClock>;
  timeouts: HermesTimeouts;
  onEvent: (frame: HermesGatewayEventFrame) => void;
  onState: (change: GatewayStateChange) => void;
}

interface GatewayGeneration {
  id: number;
  child: HermesProcess;
  ready: boolean;
  settled: boolean;
  intentionalClose: boolean;
  readyTimer: unknown;
}

/**
 * A deliberately small JSON-RPC-over-stdio client for `hermes --tui`.
 *
 * The gateway emits terminal/Ink output nowhere on stdout; stdout is treated
 * as newline-delimited JSON only. Unknown and malformed frames are ignored,
 * while a missing ready frame is a bounded startup failure. A child is never
 * restarted implicitly after it exits.
 */
export class HermesGatewayClient extends EventEmitter {
  private readonly options: HermesGatewayClientOptions;
  private generationCounter = 0;
  private generation: GatewayGeneration | null = null;
  private pending = new Map<number, PendingRpc>();
  private nextRequestId = 1;
  private disposed = false;
  private unavailable: HermesFailureCode | null = null;
  private startPromise: Promise<void> | null = null;
  private readyPayload: Record<string, unknown> | undefined;

  constructor(options: HermesGatewayClientOptions) {
    super();
    this.options = options;
    this.setMaxListeners(0);
  }

  get generationId(): number {
    return this.generation?.id ?? this.generationCounter;
  }

  get isReady(): boolean {
    return this.generation?.ready === true;
  }

  get payload(): Record<string, unknown> | undefined {
    return this.readyPayload;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new HermesEngineError("gateway_unavailable");
    if (this.generation?.ready) return;
    if (this.startPromise) return this.startPromise;
    if (this.unavailable) throw new HermesEngineError(this.unavailable);

    const promise = this.startGeneration();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  /** Explicitly start a fresh process after a crash or failed handshake. */
  async reconnect(): Promise<void> {
    if (this.disposed) throw new HermesEngineError("gateway_unavailable");
    await this.stopGeneration(true);
    this.unavailable = null;
    this.readyPayload = undefined;
    await this.start();
  }

  async request(method: string, params: unknown, timeoutMs = this.options.timeouts.requestMs): Promise<unknown> {
    await this.start();
    const generation = this.generation;
    if (!generation?.ready || generation.settled) throw new HermesEngineError("gateway_unavailable");
    const id = this.nextRequestId++;
    const timeout = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : this.options.timeouts.requestMs);

    return await new Promise<unknown>((resolve, reject) => {
      const timer = this.options.clock.setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesEngineError("timeout"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const encoded = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
        const stdin = generation.child.stdin;
        if (!stdin || stdin.writable === false) throw new Error("stdin unavailable");
        stdin.write(encoded);
      } catch {
        this.pending.delete(id);
        this.options.clock.clearTimeout(timer);
        reject(new HermesEngineError("gateway_unavailable"));
      }
    });
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.stopGeneration(true);
    this.removeAllListeners();
  }

  private async startGeneration(): Promise<void> {
    const generationId = ++this.generationCounter;
    let child: HermesProcess;
    try {
      child = this.options.spawn(this.options.cli, ["--tui"], {
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        env: this.options.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      this.unavailable = "missing_cli";
      throw new HermesEngineError("missing_cli");
    }

    const generation: GatewayGeneration = {
      id: generationId,
      child,
      ready: false,
      settled: false,
      intentionalClose: false,
      readyTimer: undefined,
    };
    this.generation = generation;
    this.readyPayload = undefined;
    this.attachChild(generation);

    await new Promise<void>((resolve, reject) => {
      generation.readyTimer = this.options.clock.setTimeout(() => {
        if (generation.ready || generation.settled) return;
        generation.intentionalClose = true;
        this.finishGeneration(generation, "timeout");
        try {
          generation.child.kill?.("SIGTERM");
        } catch {
          /* best effort */
        }
        reject(new HermesEngineError("timeout"));
      }, this.options.timeouts.initializationMs);

      const onReady = () => {
        if (generation.ready || generation.settled) return;
        generation.ready = true;
        this.options.clock.clearTimeout(generation.readyTimer);
        this.unavailable = null;
        this.options.onState({
          generation: generation.id,
          kind: "ready",
          intentional: false,
          payload: this.readyPayload,
        });
        resolve();
      };
      const onClosed = () => {
        if (generation.ready) return;
        const reason = this.unavailable ?? "gateway_unavailable";
        if (!generation.settled) this.finishGeneration(generation, reason);
        reject(new HermesEngineError(reason));
      };
      this.once(`ready:${generation.id}`, onReady);
      this.once(`closed-before-ready:${generation.id}`, onClosed);
      // A test seam (or an unusually fast executable) may emit its first
      // frame while the child listeners are being attached, before the
      // startup listeners above are registered. Reconcile that state here so
      // the initialization promise cannot wait until its timeout forever.
      if (generation.ready) resolve();
      else if (generation.settled) onClosed();
    });
  }

  private attachChild(generation: GatewayGeneration): void {
    const stdout = generation.child.stdout;
    try {
      stdout?.setEncoding?.("utf8");
    } catch {
      /* a test seam may expose a read-only stream */
    }

    let buffer = "";
    const decoder = new TextDecoder();
    const onData = (chunk: unknown) => {
      if (typeof chunk === "string") buffer += chunk;
      else if (chunk instanceof Uint8Array) buffer += decoder.decode(chunk, { stream: true });
      else buffer += String(chunk ?? "");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        this.handleFrame(generation, frame);
      }
    };
    stdout?.on("data", onData);

    // stderr is intentionally not retained, parsed, or put in errors. It can
    // contain provider payloads, paths, prompts, and credentials.
    generation.child.stderr?.on("data", () => {});
    generation.child.stderr?.on("error", () => {});
    generation.child.stdin?.on?.("error", () => {});

    generation.child.on("error", () => {
      this.finishGeneration(generation, generation.ready ? "gateway_unavailable" : "missing_cli");
    });
    generation.child.on("close", () => {
      this.finishGeneration(generation, generation.intentionalClose ? "gateway_unavailable" : "gateway_unavailable");
    });
  }

  private handleFrame(generation: GatewayGeneration, frame: unknown): void {
    if (this.generation !== generation || generation.settled || !frame || typeof frame !== "object" || Array.isArray(frame)) {
      return;
    }
    const message = frame as Record<string, unknown>;
    if (message.method === "event") {
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) return;
      const typed = params as Record<string, unknown>;
      if (typed.type === "gateway.ready") {
        this.readyPayload = safeReadyPayload(typed.payload);
        this.emit(`ready:${generation.id}`);
      }
      this.options.onEvent({ generation: generation.id, params: typed });
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.options.clock.clearTimeout(pending.timer);
    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      pending.reject(new HermesEngineError(classifyRpcError(message.error)));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "result")) {
      pending.reject(new HermesEngineError("malformed_response"));
      return;
    }
    pending.resolve(message.result);
  }

  private finishGeneration(generation: GatewayGeneration, reason: HermesFailureCode): void {
    if (generation.settled) return;
    generation.settled = true;
    this.options.clock.clearTimeout(generation.readyTimer);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.options.clock.clearTimeout(pending.timer);
      pending.reject(new HermesEngineError(reason));
    }
    if (this.generation === generation) {
      this.generation = null;
      this.unavailable = reason;
    }
    if (!generation.ready) this.emit(`closed-before-ready:${generation.id}`);
    this.options.onState({
      generation: generation.id,
      kind: "closed",
      intentional: generation.intentionalClose,
    });
  }

  private async stopGeneration(intentional: boolean): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    generation.intentionalClose = intentional;
    this.finishGeneration(generation, "gateway_unavailable");
    try {
      generation.child.stdin?.end?.();
    } catch {
      /* best effort */
    }
    try {
      generation.child.kill?.("SIGTERM");
    } catch {
      /* best effort */
    }
  }
}

interface RuntimeRecord {
  profile: string;
  generation: number;
  runtimeId: string;
  threadId: string;
  turnId: string;
  terminal: boolean;
  started: boolean;
  timer: unknown;
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function normalizeTimeouts(raw: Partial<HermesTimeouts> | undefined): HermesTimeouts {
  const pick = (key: keyof HermesTimeouts, fallback: number): number => {
    const value = raw?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    initializationMs: pick("initializationMs", DEFAULT_TIMEOUTS.initializationMs),
    requestMs: pick("requestMs", DEFAULT_TIMEOUTS.requestMs),
    turnMs: pick("turnMs", DEFAULT_TIMEOUTS.turnMs),
    reconnectMs: pick("reconnectMs", DEFAULT_TIMEOUTS.reconnectMs),
  };
}

function normalizeClock(clock: HermesClock | undefined): Required<HermesClock> {
  return {
    now: clock?.now ?? Date.now,
    setTimeout: clock?.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout)),
    clearTimeout: clock?.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  };
}

function isVBotCredential(name: string): boolean {
  return /^(?:VBOT|V_BOT|OPENMAUSBOT|OPENMAUS_BOT|OPENMAUSBOT|OPENMAUS_).*?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name)
    || /^(?:VBOT|V_BOT|OPENMAUSBOT|OPENMAUS_BOT|OPENMAUSBOT)_/i.test(name);
}

/** Build the child environment without passing V Bot credentials downstream. */
export function sanitizeHermesChildEnv(
  environment: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = { ...base, ...environment };
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(merged)) {
    if (!name || isVBotCredential(name) || value === undefined) continue;
    output[name] = value;
  }
  return output;
}

function normalizeProfile(profile: string): string {
  if (typeof profile !== "string") throw new HermesEngineError("profile_unavailable");
  const value = profile;
  if (value.length === 0 || value.length > PROFILE_MAX_LENGTH || value.trim() !== value || !PROFILE_PATTERN.test(value)) {
    throw new HermesEngineError("profile_unavailable");
  }
  return value.toLowerCase();
}

function safeReadyPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "string" && version.length > 0 && version.length <= MAX_READY_VERSION_LENGTH
    && version.trim() === version && !/[\u0000-\u001f\u007f\u0080-\u009f]/.test(version)
    ? { version }
    : undefined;
}

function classifyRpcError(error: unknown): HermesFailureCode {
  if (!error || typeof error !== "object") return "upstream_error";
  const record = error as Record<string, unknown>;
  const code = record.code;
  const normalizedCode = typeof code === "number" ? String(code) : typeof code === "string" ? code.toUpperCase() : "";
  if (["401", "403", "AUTH", "UNAUTHORIZED", "INVALID_CREDENTIALS"].includes(normalizedCode)) {
    return "invalid_credentials";
  }
  return "upstream_error";
}

function errorForLookup(result: HermesCanonicalLookup): HermesEngineError {
  if (result.state === "absent") return new HermesEngineError("profile_unavailable");
  if (result.state === "unknown") return new HermesEngineError(result.code);
  return new HermesEngineError("malformed_response");
}

function profileLockKey(profile: string): string {
  return profile.toLowerCase();
}

function usageValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeUsage(value: unknown): { input: number; output: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = usageValue(record.input) ?? usageValue(record.input_tokens) ?? usageValue(record.prompt_tokens);
  const output = usageValue(record.output) ?? usageValue(record.output_tokens) ?? usageValue(record.completion_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { input, output };
}

function eventText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return undefined;
  return value;
}

function statusStopReason(status: string): string | null {
  if (status === "complete" || status === "success") return null;
  if (status === "cancelled" || status === "canceled" || status === "interrupted") return "interrupted";
  return "error";
}

/** The Wave 1 Hermes Bot Chat adapter. */
export class HermesBotAdapter implements HermesBotEngine {
  private readonly clock: Required<HermesClock>;
  private readonly timeouts: HermesTimeouts;
  private readonly client: HermesGatewayClient;
  private readonly locks = new Map<string, AsyncLock>();
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly readiness: HermesReadiness = {};
  private lastProfiles: HermesDiscovery["profiles"] = [];
  private closed = false;

  constructor(options: HermesBotEngineOptions = {}) {
    this.clock = normalizeClock(options.clock);
    this.timeouts = normalizeTimeouts(options.timeouts);
    const environment = sanitizeHermesChildEnv(options.environment ?? options.env ?? {});
    this.client = new HermesGatewayClient({
      cli: options.cli ?? DEFAULT_CLI,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      environment,
      spawn:
        options.spawn
        ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as unknown as HermesProcess),
      clock: this.clock,
      timeouts: this.timeouts,
      onEvent: (frame) => this.handleGatewayEvent(frame),
      onState: (change) => this.handleGatewayState(change),
    });
  }

  async discover(): Promise<HermesDiscovery> {
    try {
      await this.client.start();
      const payload = await this.client.request("profiles.list", { include_sessions: true });
      const normalized = normalizeProfileRowsResult(payload);
      if (normalized.state === "unknown") {
        return this.discoveryUnavailable(normalized.code);
      }
      this.readiness.roster = true;
      this.readiness.events = true;
      this.lastProfiles = normalized.profiles;
      return {
        state: "available",
        authenticated: true,
        ...(this.version() ? { version: this.version() } : {}),
        capabilities: projectHermesCapabilities(this.readiness),
        profiles: normalized.profiles,
      };
    } catch (error) {
      const safe = asHermesError(error);
      return this.discoveryUnavailable(safe.code);
    }
  }

  async resolveCanonical(profile: string): Promise<HermesCanonicalChat> {
    const result = await this.lookupCanonical(profile);
    if (result.state !== "present") throw errorForLookup(result);
    return result.chat;
  }

  /** Internal state-preserving lookup useful to the roster and test seams. */
  async lookupCanonical(profile: string): Promise<HermesCanonicalLookup> {
    const normalizedProfile = normalizeProfile(profile);
    return await this.lockFor(normalizedProfile).run(async () => {
      try {
        await this.client.start();
        const payload = await this.client.request(
          "session.list",
          { profile: normalizedProfile, title: "Bot Chat", include_hidden: true, limit: 200 },
        );
      const normalized = normalizeCanonicalLookup(payload, normalizedProfile);
      if (normalized.state !== "unknown") this.readiness.canonicalChat = true;
      return normalized;
      } catch (error) {
        const safe = asHermesError(error);
        return { state: "unknown", code: canonicalUnknownCode(safe.code), message: safe.message };
      }
    });
  }

  async send(input: {
    profile: string;
    text: string;
    model?: string;
    cwd?: string;
    threadId: string;
    turnId: string;
  }): Promise<{ turnId: string }> {
    if (!input || typeof input !== "object") throw new HermesEngineError("malformed_response");
    const profile = normalizeProfile(input.profile);
    if (typeof input.text !== "string" || input.text.length === 0 || typeof input.threadId !== "string" || typeof input.turnId !== "string") {
      throw new HermesEngineError("malformed_response");
    }
    return await this.lockFor(profile).run(async () => {
      if (this.closed) throw new HermesEngineError("gateway_unavailable");
      const existing = this.runtimeFor(profile);
      if (existing) throw new HermesEngineError("upstream_error");
      const canonical = await this.lookupCanonicalOutsideLock(profile);
      if (canonical.state !== "present") throw errorForLookup(canonical);
      await this.client.start();
      let resume: unknown;
      try {
        resume = await this.client.request("session.resume", { profile, session_id: canonical.chat.resolvedSessionId });
      } catch (error) {
        throw asHermesError(error);
      }
      const runtimeId = runtimeSessionId(resume);
      if (!runtimeId) throw new HermesEngineError("malformed_response");
      const generation = this.client.generationId;
      const runtime: RuntimeRecord = {
        profile,
        generation,
        runtimeId,
        threadId: input.threadId,
        turnId: input.turnId,
        terminal: false,
        started: false,
        timer: undefined,
      };
      this.runtimes.set(this.runtimeKey(profile, generation), runtime);
      runtime.started = true;
      this.emitRuntime(runtime, { type: "turn.started" });
      runtime.timer = this.clock.setTimeout(() => {
        this.terminateRuntime(runtime, false, "timeout");
      }, this.timeouts.turnMs);
      try {
        await this.client.request("prompt.submit", { session_id: runtimeId, text: input.text });
        this.readiness.send = true;
      } catch (error) {
        const safe = asHermesError(error);
        this.terminateRuntime(runtime, false, safe.code);
        throw safe;
      }
      return { turnId: input.turnId };
    });
  }

  async interrupt(profile: string, turnId?: string): Promise<void> {
    const normalizedProfile = normalizeProfile(profile);
    await this.lockFor(normalizedProfile).run(async () => {
      const runtime = this.runtimeFor(normalizedProfile);
      if (!runtime || (turnId !== undefined && runtime.turnId !== turnId)) return;
      let failure: HermesEngineError | undefined;
      try {
        await this.client.request("session.interrupt", { session_id: runtime.runtimeId });
        this.readiness.stop = true;
      } catch (error) {
        failure = asHermesError(error);
      } finally {
        this.terminateRuntime(runtime, false, failure ? failure.code : "interrupted");
      }
      if (failure) throw failure;
    });
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const runtime of [...this.runtimes.values()]) this.terminateRuntime(runtime, true, "gateway_unavailable");
    this.runtimes.clear();
    await this.client.close();
    this.listeners.clear();
  }

  /** Explicit reconnect; intentionally not part of the minimal SPI. */
  async reconnect(): Promise<void> {
    if (this.closed) throw new HermesEngineError("gateway_unavailable");
    for (const runtime of [...this.runtimes.values()]) this.terminateRuntime(runtime, false, "gateway_unavailable");
    await this.client.reconnect();
  }

  get capabilities(): HermesCapabilityFlags {
    return projectHermesCapabilities(this.readiness);
  }

  private async lookupCanonicalOutsideLock(profile: string): Promise<HermesCanonicalLookup> {
    try {
      await this.client.start();
      const payload = await this.client.request(
        "session.list",
        { profile, title: "Bot Chat", include_hidden: true, limit: 200 },
      );
      const normalized = normalizeCanonicalLookup(payload, profile);
      if (normalized.state !== "unknown") this.readiness.canonicalChat = true;
      return normalized;
    } catch (error) {
      const safe = asHermesError(error);
      return { state: "unknown", code: canonicalUnknownCode(safe.code), message: safe.message };
    }
  }

  private handleGatewayState(change: GatewayStateChange): void {
    if (change.kind === "ready") {
      this.readiness.events = true;
      return;
    }
    for (const key of Object.keys(this.readiness) as Array<keyof HermesReadiness>) {
      delete this.readiness[key];
    }
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.generation !== change.generation) continue;
      this.terminateRuntime(runtime, change.intentional, "gateway_unavailable");
    }
  }

  private handleGatewayEvent(frame: HermesGatewayEventFrame): void {
    const params = frame.params;
    const type = params.type;
    if (type === "gateway.ready") return;
    if (typeof type !== "string") return;
    const sessionId = typeof params.session_id === "string" ? params.session_id : "";
    if (!sessionId) return;
    const runtime = [...this.runtimes.values()].find((candidate) => candidate.generation === frame.generation && candidate.runtimeId === sessionId);
    if (!runtime || runtime.terminal) return;
    if (type === "message.start") {
      if (!runtime.started) {
        runtime.started = true;
        this.emitRuntime(runtime, { type: "turn.started" });
      }
      return;
    }
    if (type === "message.delta") {
      const payload = asRecord(params.payload);
      const delta = eventText(payload?.text);
      if (delta) this.emitRuntime(runtime, { type: "content.delta", streamKind: "assistant_text", delta });
      return;
    }
    if (type !== "message.complete") return;
    const payload = asRecord(params.payload);
    const text = eventText(payload?.text);
    const status = typeof payload?.status === "string" ? payload.status : "";
    const usageProvided = payload?.usage !== undefined && payload?.usage !== null;
    const usage = normalizeUsage(payload?.usage);
    if (!text || !["complete", "success", "error", "interrupted", "cancelled", "canceled"].includes(status) || (usageProvided && !usage)) {
      this.terminateRuntime(runtime, false, "malformed_response");
      return;
    }
    this.readiness.finalResponse = true;
    this.terminateRuntime(runtime, false, statusStopReason(status) ?? "complete", {
      assistantText: text,
      usage,
      ok: status === "complete" || status === "success",
    });
  }

  private terminateRuntime(
    runtime: RuntimeRecord,
    silent: boolean,
    reason: string,
    result?: { assistantText?: string; usage?: { input: number; output: number }; ok?: boolean },
  ): void {
    if (runtime.terminal) return;
    runtime.terminal = true;
    this.clock.clearTimeout(runtime.timer);
    this.runtimes.delete(this.runtimeKey(runtime.profile, runtime.generation));
    if (silent) return;
    if (result?.assistantText) {
      this.emitRuntime(runtime, { type: "item.completed", itemType: "assistant_text", text: result.assistantText });
    } else if (reason === "malformed_response") {
      this.emitRuntime(runtime, { type: "runtime.error", message: new HermesEngineError("malformed_response").message });
    }
    const isOk = result?.ok === true;
    this.emitRuntime(runtime, {
      type: "turn.completed",
      ok: isOk,
      stopReason: isOk ? null : reason,
      ...(result?.usage ? { usage: result.usage } : {}),
    });
  }

  private emitRuntime(runtime: RuntimeRecord, event: { type: string; [key: string]: unknown }): void {
    const normalized = {
      eventId: newEventId(),
      provider: "hermesBot",
      threadId: runtime.threadId,
      turnId: runtime.turnId,
      createdAt: new Date(this.clock.now()).toISOString(),
      ...event,
    } as RuntimeEvent;
    for (const listener of [...this.listeners]) listener(normalized);
  }

  private runtimeKey(profile: string, generation: number): string {
    return `${generation}:${profile}`;
  }

  private runtimeFor(profile: string): RuntimeRecord | undefined {
    const generation = this.client.generationId;
    return this.runtimes.get(this.runtimeKey(profile, generation));
  }

  private lockFor(profile: string): AsyncLock {
    const key = profileLockKey(profile);
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new AsyncLock();
      this.locks.set(key, lock);
    }
    return lock;
  }

  private version(): string | undefined {
    const version = this.client.payload?.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  }

  private discoveryUnavailable(code: HermesFailureCode, profiles = this.lastProfiles): HermesDiscovery {
    const reason = code === "upstream_error" || code === "profile_unavailable" ? "state_unavailable" : code;
    return {
      state: "unavailable",
      reason,
      capabilities: projectHermesCapabilities(this.readiness),
      profiles,
    };
  }
}

function runtimeSessionId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["session_id", "session_key"] as const) {
    const id = record[key];
    if (typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id)) return id;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asHermesError(error: unknown): HermesEngineError {
  if (error instanceof HermesEngineError) return error;
  return new HermesEngineError("upstream_error");
}

function canonicalUnknownCode(code: HermesFailureCode): "state_unavailable" | "malformed_response" {
  return code === "malformed_response" ? "malformed_response" : "state_unavailable";
}

interface HermesReadiness {
  roster?: boolean;
  canonicalChat?: boolean;
  send?: boolean;
  finalResponse?: boolean;
  events?: boolean;
  stop?: boolean;
}

export function createHermesBotEngine(options: HermesBotEngineOptions = {}): HermesBotAdapter {
  return new HermesBotAdapter(options);
}

export const createHermesAdapter = createHermesBotEngine;
export const createHermesEngine = createHermesBotEngine;
