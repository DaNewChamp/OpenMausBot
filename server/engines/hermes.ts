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
const MAX_FRAME_STRING_LENGTH = 200_000;
const MAX_FRAME_LENGTH = 2_000_000;
const SESSION_SCOPED_EVENT_TYPES = new Set(["message.start", "message.delta", "message.complete"]);

/**
 * Hermes is responsible for its own provider credentials.  The child gets a
 * deliberately small, positive environment allowlist rather than a copied
 * process environment with a few names removed.  In particular, provider,
 * workspace, and V Bot variables are never inherited by accident.
 */
const HERMES_CHILD_ENV_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "PATH",
  "HERMES_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_XMUSIC",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLUMNS",
  "LINES",
]);

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
  /** Adopt the exact canonical Bot Chat, minting it only after a successful
   * empty title lookup. Optional so existing injected engines remain source
   * compatible while setup-capable adapters opt in. */
  ensureCanonical?(profile: string): Promise<HermesCanonicalChat>;
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
  reason?: HermesFailureCode;
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
  readyResolve?: () => void;
  readyReject?: (error: HermesEngineError) => void;
}

/**
 * A deliberately small JSON-RPC-over-stdio client for `hermes --tui`.
 *
 * The gateway emits terminal/Ink output nowhere on stdout; stdout is treated
 * as newline-delimited JSON only. Every frame is validated as a JSON-RPC 2.0
 * envelope; malformed protocol or event data fails the generation closed.
 * A missing ready frame is a bounded startup failure, and a child is never
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
    if (this.unavailable) {
      if (!this.generation || this.generation.settled) {
        this.unavailable = null;
      } else {
        throw new HermesEngineError(this.unavailable);
      }
    }

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
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = this.options.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        // Stop the generation so no late child can become the active gateway.
        void this.stopGeneration(true);
        this.unavailable = "timeout";
        reject(new HermesEngineError("timeout"));
      }, this.options.timeouts.reconnectMs);
      this.start().then(
        () => {
          if (settled) return;
          settled = true;
          this.options.clock.clearTimeout(timer);
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.options.clock.clearTimeout(timer);
          reject(asHermesError(error));
        },
      );
    });
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

    // Install the startup promise before attaching child listeners.  A test
    // process (and a very fast real process) can synchronously emit
    // gateway.ready from the first listener registration; storing the
    // resolver on the generation makes that event observable instead of
    // losing it between attachChild() and once().
    const ready = new Promise<void>((resolve, reject) => {
      generation.readyResolve = resolve;
      generation.readyReject = reject;
    });
    generation.readyTimer = this.options.clock.setTimeout(() => {
      if (generation.ready || generation.settled) return;
      generation.intentionalClose = true;
      this.finishGeneration(generation, "timeout");
      try {
        generation.child.kill?.("SIGTERM");
      } catch {
        /* best effort */
      }
    }, this.options.timeouts.initializationMs);

    this.attachChild(generation);
    await ready;
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
      if (buffer.length > MAX_FRAME_LENGTH) {
        this.protocolFailure(generation);
        return;
      }
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
          this.protocolFailure(generation);
          return;
        }
        if (!this.handleFrame(generation, frame)) return;
      }
    };
    // stderr is intentionally not retained, parsed, or put in errors. It can
    // contain provider payloads, paths, prompts, and credentials.
    generation.child.stderr?.on("data", () => {});
    generation.child.stderr?.on("error", () => {});
    generation.child.stdin?.on?.("error", () => {});

    generation.child.on("error", (error: unknown) => {
      // A spawn throw is classified as missing_cli.  Once a ChildProcess has
      // been returned, an error/exit is a gateway failure regardless of when
      // it occurs; do not expose Node's path or stderr text.
      this.finishGeneration(generation, childErrorCode(error));
    });
    generation.child.on("close", () => {
      // A trailing partial line is not a valid JSON-RPC frame.  Treat it as a
      // protocol failure before the ordinary process-close path.
      if (buffer.trim()) {
        this.protocolFailure(generation);
        return;
      }
      this.finishGeneration(generation, "gateway_unavailable");
    });

    // Register lifecycle listeners before stdout so a synchronous test seam
    // (or immediately-exiting child) cannot lose its close/error transition.
    stdout?.on("data", onData);
  }

  private handleFrame(generation: GatewayGeneration, frame: unknown): boolean {
    if (this.generation !== generation || generation.settled) return true;
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      this.protocolFailure(generation);
      return false;
    }
    const message = frame;
    if (message.method === "event") {
      if (hasOwn(message, "id") || hasOwn(message, "result") || hasOwn(message, "error")) {
        this.protocolFailure(generation);
        return false;
      }
      const params = sanitizeGatewayEvent(message.params);
      if (!params) {
        this.protocolFailure(generation);
        return false;
      }
      if (params.type === "gateway.ready") this.markReady(generation, params.payload as Record<string, unknown> | undefined);
      if (!generation.settled) this.options.onEvent({ generation: generation.id, params });
      return !generation.settled;
    }
    if (hasOwn(message, "method") || hasOwn(message, "params") || !hasOwn(message, "id")) {
      this.protocolFailure(generation);
      return false;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id) || message.id < 1) {
      this.protocolFailure(generation);
      return false;
    }
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");
    if (hasResult === hasError || (hasError && !isSafeRpcError(message.error))) {
      this.protocolFailure(generation);
      return false;
    }
    const pending = this.pending.get(message.id);
    // A well-formed response for an old/unknown id is harmless (for example,
    // a late response racing an explicit reconnect).  It must not affect a
    // request with a different id.
    if (!pending) return true;
    this.pending.delete(message.id);
    this.options.clock.clearTimeout(pending.timer);
    if (hasError) {
      pending.reject(new HermesEngineError(classifyRpcError(message.error)));
      return true;
    }
    pending.resolve(message.result);
    return true;
  }

  private markReady(generation: GatewayGeneration, payload: Record<string, unknown> | undefined): void {
    if (this.generation !== generation || generation.settled || generation.ready) return;
    generation.ready = true;
    this.readyPayload = payload;
    this.options.clock.clearTimeout(generation.readyTimer);
    this.unavailable = null;
    // State is updated before callbacks so a synchronous ready frame cannot
    // be observed as "not ready" by the adapter's state listener.
    this.options.onState({
      generation: generation.id,
      kind: "ready",
      intentional: false,
      payload,
    });
    generation.readyResolve?.();
    generation.readyResolve = undefined;
    generation.readyReject = undefined;
  }

  private protocolFailure(generation: GatewayGeneration): void {
    if (generation.settled) return;
    generation.intentionalClose = false;
    this.finishGeneration(generation, "malformed_response");
    try {
      generation.child.kill?.("SIGTERM");
    } catch {
      /* best effort */
    }
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
    if (!generation.ready) {
      generation.readyReject?.(new HermesEngineError(reason));
      generation.readyResolve = undefined;
      generation.readyReject = undefined;
    }
    this.options.onState({
      generation: generation.id,
      kind: "closed",
      intentional: generation.intentionalClose,
      reason,
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
  /** Normalized profile or handle supplied by the caller at send time. */
  requestedProfile: string;
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

function isAllowedHermesEnvName(name: string): boolean {
  return HERMES_CHILD_ENV_KEYS.has(name);
}

/** Build the child environment from the positive Hermes-only allowlist. */
export function sanitizeHermesChildEnv(
  environment: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = { ...base, ...environment };
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(merged)) {
    if (!name || !isAllowedHermesEnvName(name) || value === undefined) continue;
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

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeFrameString(value: unknown, maxLength = MAX_FRAME_STRING_LENGTH): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f\u0080-\u009f]/.test(value);
}

function safeMessageText(value: unknown, maxLength = MAX_FRAME_STRING_LENGTH): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    // Newlines/tabs are valid assistant text; reject the remaining control
    // and C1 ranges that could be interpreted as terminal escape material.
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/.test(value);
}

function safeOpaqueId(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\s\u0000-\u001f\u007f\u0080-\u009f]/.test(value);
}

function safeReadyPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  if (hasOwn(value, "version")) {
    if (!safeFrameString(value.version, MAX_READY_VERSION_LENGTH) || value.version.length === 0) return undefined;
    output.version = value.version;
  }
  // The pinned gateway sends a nested skin object here.  Validate its shape
  // at the boundary but intentionally drop it (and any path-like metadata).
  if (hasOwn(value, "skin") && value.skin !== undefined && !isRecord(value.skin) && !safeFrameString(value.skin, MAX_READY_VERSION_LENGTH)) {
    return undefined;
  }
  if (hasOwn(value, "path") && value.path !== undefined && !safeFrameString(value.path, MAX_FRAME_STRING_LENGTH)) {
    return undefined;
  }
  return output;
}

function isSafeRpcError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  // JSON-RPC 2.0 requires an integer error code.  String codes are not
  // accepted even when they look like a known authentication code; treating
  // them as malformed keeps the protocol boundary deterministic.
  if (typeof value.code !== "number" || !Number.isSafeInteger(value.code)) return false;
  // The message is deliberately discarded (it may contain paths, prompts,
  // or provider payloads), but its type/size must still be bounded.
  if (hasOwn(value, "message") && (typeof value.message !== "string" || value.message.length > MAX_FRAME_STRING_LENGTH)) return false;
  return true;
}

/**
 * Validate and copy only the event fields consumed by the adapter.  Hermes
 * emits many UI/status events; unknown payloads are deliberately dropped so
 * provider data, paths, and prompts cannot cross the transport boundary.
 */
function sanitizeGatewayEvent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !safeFrameString(value.type, 120) || value.type.length === 0) return undefined;
  const type = value.type;
  const output: Record<string, unknown> = { type };
  const sessionId = value.session_id;
  if (sessionId !== undefined) {
    // Hermes emits global watcher/status events with an explicit empty
    // session_id.  They are valid and intentionally ignored by the adapter;
    // message events remain session-scoped and require a strict opaque id.
    if (sessionId === "") {
      if (SESSION_SCOPED_EVENT_TYPES.has(type)) return undefined;
    } else if (!safeOpaqueId(sessionId)) {
      return undefined;
    }
    output.session_id = sessionId;
  }

  if (type === "gateway.ready") {
    if (!hasOwn(value, "payload")) return undefined;
    const payload = safeReadyPayload(value.payload);
    if (!payload) return undefined;
    output.payload = payload;
    return output;
  }

  if (SESSION_SCOPED_EVENT_TYPES.has(type)) {
    if (!safeOpaqueId(sessionId)) return undefined;
    if (type === "message.start") {
      if (hasOwn(value, "payload") && value.payload !== undefined && !isRecord(value.payload)) return undefined;
      return output;
    }
    if (!hasOwn(value, "payload") || !isRecord(value.payload)) return undefined;
    const payload = value.payload;

    if (!hasOwn(payload, "text") || !safeMessageText(payload.text)) return undefined;
    const cleanPayload: Record<string, unknown> = { text: payload.text };
    if (type === "message.complete") {
      if (!hasOwn(payload, "status") || !safeFrameString(payload.status, 80) || payload.status.length === 0) return undefined;
      cleanPayload.status = payload.status;
      if (hasOwn(payload, "usage") && payload.usage !== undefined && payload.usage !== null) {
        if (!isRecord(payload.usage)) return undefined;
        const cleanUsage: Record<string, unknown> = {};
        for (const key of ["input", "output", "input_tokens", "output_tokens", "prompt_tokens", "completion_tokens"] as const) {
          if (hasOwn(payload.usage, key)) {
            const numeric = usageValue(payload.usage[key]);
            if (numeric === undefined) return undefined;
            cleanUsage[key] = numeric;
          }
        }
        if (Object.keys(cleanUsage).length === 0) return undefined;
        cleanPayload.usage = cleanUsage;
      }
    }
    output.payload = cleanPayload;
    return output;
  }

  if (hasOwn(value, "payload") && value.payload !== undefined && !isRecord(value.payload)) return undefined;
  // For status/unknown event kinds, retain only the bounded type/session
  // fields.  Their payload is intentionally not forwarded to the adapter.
  return output;
}

function classifyRpcError(error: unknown): HermesFailureCode {
  if (!error || typeof error !== "object") return "upstream_error";
  const record = error as Record<string, unknown>;
  const code = record.code;
  const normalizedCode = typeof code === "number" ? String(code) : "";
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
  const normalized = profile.toLowerCase();
  // The default Hermes profile is exposed to V Bot through the public
  // `hermes` handle. Keep both names on one lock/runtime identity so a
  // concurrent alias/canonical send cannot resume or overwrite the same
  // Bot Chat twice.
  return normalized === "hermes" ? "default" : normalized;
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
  private rosterAvailable = false;
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
        this.demoteCapabilities();
        this.rosterAvailable = false;
        return this.discoveryUnavailable(normalized.code);
      }
      this.readiness.roster = true;
      this.readiness.events = true;
      this.lastProfiles = normalized.profiles;
      this.rosterAvailable = true;
      return {
        state: "available",
        ...(this.version() ? { version: this.version() } : {}),
        capabilities: projectHermesCapabilities(this.readiness),
        profiles: normalized.profiles,
      };
    } catch (error) {
      const safe = asHermesError(error);
      this.demoteCapabilities();
      this.rosterAvailable = false;
      return this.discoveryUnavailable(safe.code);
    }
  }

  async resolveCanonical(profile: string): Promise<HermesCanonicalChat> {
    const result = await this.lookupCanonical(profile);
    if (result.state !== "present") throw errorForLookup(result);
    return result.chat;
  }

  /** Resolve the canonical Bot Chat, adopting an existing row or creating it
   * only after an authoritative empty exact-title lookup. Creation is kept
   * under the same profile lock as lookup/send so concurrent setup requests
   * cannot mint duplicate titles. A successful create is never trusted as
   * identity: the row is looked up again and only that result is returned. */
  async ensureCanonical(profile: string): Promise<HermesCanonicalChat> {
    const normalizedProfile = normalizeProfile(profile);
    return await this.lockFor(normalizedProfile).run(async () => {
      if (this.closed) throw new HermesEngineError("gateway_unavailable");
      let canonical = await this.lookupCanonicalOutsideLock(normalizedProfile);
      if (canonical.state === "present") return canonical.chat;
      if (canonical.state === "unknown") throw errorForLookup(canonical);

      await this.client.start();
      try {
        const created = await this.client.request("session.create", {
          profile: normalizedProfile,
          title: "Bot Chat",
          hidden: true,
          source: "tui",
        });
        if (!createdSessionId(created)) {
          this.demoteCapabilities();
          throw new HermesEngineError("malformed_response");
        }
      } catch (error) {
        this.demoteCapabilities();
        throw asHermesError(error);
      }

      canonical = await this.lookupCanonicalOutsideLock(normalizedProfile);
      if (canonical.state !== "present") {
        this.demoteCapabilities();
        // A create response is not canonical identity. If the exact title
        // cannot be re-resolved, stop without another create attempt.
        throw new HermesEngineError("malformed_response");
      }
      this.readiness.canonicalChat = true;
      return canonical.chat;
    });
  }

  /** Internal state-preserving lookup useful to the roster and test seams. */
  async lookupCanonical(profile: string): Promise<HermesCanonicalLookup> {
    let normalizedProfile: string;
    try {
      normalizedProfile = normalizeProfile(profile);
    } catch (error) {
      const safe = asHermesError(error);
      return { state: "unknown", code: "profile_unavailable", message: safe.message };
    }
    return await this.lockFor(normalizedProfile).run(async () => this.lookupCanonicalOutsideLock(normalizedProfile));
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
      const resolvedProfile = canonical.chat.profile;
      if (this.runtimeFor(resolvedProfile)) throw new HermesEngineError("upstream_error");
      await this.client.start();
      let resume: unknown;
      try {
        resume = await this.client.request("session.resume", { profile: resolvedProfile, session_id: canonical.chat.resolvedSessionId });
      } catch (error) {
        this.demoteCapabilities();
        throw asHermesError(error);
      }
      const runtimeId = runtimeSessionId(resume);
      if (!runtimeId) {
        this.demoteCapabilities();
        throw new HermesEngineError("malformed_response");
      }
      const generation = this.client.generationId;
      const runtime: RuntimeRecord = {
        profile: resolvedProfile,
        requestedProfile: profile,
        generation,
        runtimeId,
        threadId: input.threadId,
        turnId: input.turnId,
        terminal: false,
        started: false,
        timer: undefined,
      };
      this.runtimes.set(this.runtimeKey(resolvedProfile, generation), runtime);
      runtime.started = true;
      this.emitRuntime(runtime, { type: "turn.started" });
      // Hermes' runtime session id is an ephemeral gateway handle.  The
      // harness still needs the canonical lifecycle marker, but exposing that
      // handle as `session.started.sessionId` would make the normal event fold
      // persist it as a provider resume cursor.  A null session id preserves
      // the shared event contract without leaking or persisting Hermes ids.
      this.emitRuntime(runtime, { type: "session.started", sessionId: null });
      runtime.timer = this.clock.setTimeout(() => {
        this.demoteCapabilities();
        this.terminateRuntime(runtime, false, "timeout");
      }, this.timeouts.turnMs);
      try {
        await this.client.request("prompt.submit", { session_id: runtimeId, text: input.text });
        this.readiness.send = true;
      } catch (error) {
        const safe = asHermesError(error);
        this.demoteCapabilities();
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
        this.demoteCapabilities();
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
    const discovered = await this.requireDiscoveredProfile(profile);
    if (discovered.state !== "available") {
      const code = discovered.code;
      const error = new HermesEngineError(code);
      return { state: "unknown", code, message: error.message };
    }
    const resolvedProfile = discovered.profile;
    try {
      await this.client.start();
      const payload = await this.client.request(
        "session.list",
        { profile: resolvedProfile, title: "Bot Chat", include_hidden: true, limit: 200 },
      );
      const normalized = normalizeCanonicalLookup(payload, resolvedProfile);
      if (normalized.state !== "unknown") {
        this.readiness.canonicalChat = true;
        if (
          normalized.state === "present" &&
          canonicalHiddenState(payload, normalized.chat.rootSessionId) === false
        ) {
          await this.client.request("session.set_hidden", {
            profile: resolvedProfile,
            session_id: normalized.chat.rootSessionId,
            hidden: true,
          });
        }
      } else {
        this.demoteCapabilities();
      }
      return normalized;
    } catch (error) {
      const safe = asHermesError(error);
      this.demoteCapabilities();
      return { state: "unknown", code: canonicalUnknownCode(safe.code), message: safe.message };
    }
  }

  private async requireDiscoveredProfile(
    profile: string,
  ): Promise<
    | { state: "available"; profile: string }
    | { state: "unavailable"; code: Extract<HermesCanonicalLookup, { state: "unknown" }>["code"] }
  > {
    let normalized: string;
    try {
      normalized = normalizeProfile(profile);
    } catch {
      return { state: "unavailable", code: "profile_unavailable" };
    }

    // Refresh the roster for every lookup/send.  A binding can outlive a
    // profile deletion or rename; stale rows are never used to guess a
    // default database session.
    const discovery = await this.discover();
    if (discovery.state !== "available" || !this.rosterAvailable) {
      // `discover()` already reduced all process/RPC details to fixed safe
      // setup diagnostics. Preserve those codes so callers can distinguish a
      // missing CLI, invalid credentials, gateway outage, or timeout from an
      // otherwise readable but unavailable Hermes state.
      const code = discovery.reason ?? "state_unavailable";
      return { state: "unavailable", code: canonicalUnknownCode(code) };
    }

    const matches = discovery.profiles.filter((row) =>
      row.availability === "available" && (row.profile === normalized || row.handle === normalized));
    if (matches.length !== 1 || !matches[0]?.profile) {
      return { state: "unavailable", code: "profile_unavailable" };
    }
    return { state: "available", profile: matches[0].profile };
  }

  private demoteCapabilities(): void {
    for (const key of Object.keys(this.readiness) as Array<keyof HermesReadiness>) {
      delete this.readiness[key];
    }
  }

  private handleGatewayState(change: GatewayStateChange): void {
    if (change.kind === "ready") {
      this.readiness.events = true;
      return;
    }
    this.rosterAvailable = false;
    for (const key of Object.keys(this.readiness) as Array<keyof HermesReadiness>) {
      delete this.readiness[key];
    }
    const reason = change.reason ?? "gateway_unavailable";
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.generation !== change.generation) continue;
      this.terminateRuntime(runtime, change.intentional, reason);
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
    if (type === "error") {
      // Hermes error events can carry provider diagnostics in their payload.
      // Drop that text and terminate with a fixed safe reason.
      this.demoteCapabilities();
      this.terminateRuntime(runtime, false, "upstream_error");
      return;
    }
    if (type !== "message.complete") return;
    const payload = asRecord(params.payload);
    const text = eventText(payload?.text);
    const status = typeof payload?.status === "string" ? payload.status : "";
    const usageProvided = payload?.usage !== undefined && payload?.usage !== null;
    const usage = normalizeUsage(payload?.usage);
    if (!text || !["complete", "success", "error", "interrupted", "cancelled", "canceled"].includes(status) || (usageProvided && !usage)) {
      this.demoteCapabilities();
      this.terminateRuntime(runtime, false, "malformed_response");
      return;
    }
    const successful = status === "complete" || status === "success";
    this.readiness.finalResponse = successful;
    this.terminateRuntime(runtime, false, statusStopReason(status) ?? "complete", {
      // Error/cancellation payload text is provider diagnostics, not an
      // assistant answer; do not project it into V Bot transcripts.
      ...(successful ? { assistantText: text } : {}),
      usage,
      ok: successful,
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
    }
    const isOk = result?.ok === true;
    if (!isOk && reason !== "interrupted") {
      this.emitRuntime(runtime, {
        type: "runtime.error",
        message: runtimeErrorMessage(reason),
        setup: hermesRuntimeErrorIsSetup(reason),
      });
    }
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
    // Match the canonical profile and the caller's original normalized
    // profile/handle. The latter is captured at runtime start so an active
    // turn remains interruptible after a roster refresh deletes or ambiguates
    // that handle; no stale identity is guessed or reminted.
    const requestedProfile = profile.toLowerCase();
    return [...this.runtimes.values()].find((candidate) =>
      candidate.generation === generation
      && (
        candidate.profile === requestedProfile
        || candidate.requestedProfile === requestedProfile
        // `hermes` is an alias for the default profile, but a real named
        // profile called `hermes` is still valid when no default exists.
        || (candidate.profile === "default" && (requestedProfile === "hermes" || candidate.requestedProfile === "hermes"))
      ));
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
    const reason = code === "upstream_error" || code === "profile_unavailable" || code === "groups_unavailable"
      ? "state_unavailable"
      : code;
    const staleProfiles = profiles.map((profile) => ({
      ...profile,
      canonicalChat: "unknown" as const,
      availability: "unavailable" as const,
    }));
    return {
      state: "unavailable",
      reason,
      capabilities: projectHermesCapabilities(this.readiness),
      profiles: staleProfiles,
    };
  }
}

function canonicalHiddenState(payload: unknown, rootSessionId: string): boolean | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const sessions = (payload as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return undefined;
  for (const session of sessions) {
    if (!session || typeof session !== "object" || Array.isArray(session)) continue;
    const row = session as Record<string, unknown>;
    if (row.id !== rootSessionId) continue;
    return typeof row.hidden === "boolean" ? row.hidden : undefined;
  }
  return undefined;
}

function createdSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.session && typeof record.session === "object" && !Array.isArray(record.session)
    ? record.session as Record<string, unknown>
    : undefined;
  for (const candidate of [record.id, record.session_id, record.sessionId, nested?.id, nested?.session_id]) {
    if (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= 256 &&
      candidate.trim() === candidate &&
      !/[\u0000-\u001f\u007f\u0080-\u009f\s]/.test(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function runtimeErrorMessage(reason: string): string {
  switch (reason) {
    case "missing_cli":
    case "invalid_credentials":
    case "gateway_unavailable":
    case "state_unavailable":
    case "malformed_response":
    case "timeout":
    case "profile_unavailable":
    case "groups_unavailable":
    case "upstream_error":
      return new HermesEngineError(reason).message;
    default:
      // Runtime reasons are internal values. Unknown values still fail
      // closed to a fixed message rather than crossing the event boundary.
      return new HermesEngineError("upstream_error").message;
  }
}

/** Runtime failures are not all setup failures.  In particular, a timeout
 * after a turn has been accepted is a transient turn result and must leave the
 * UI's retry path available.  Startup/discovery/gateway/profile failures are
 * still setup work the user must fix first. */
function hermesRuntimeErrorIsSetup(reason: string): boolean {
  switch (reason) {
    case "upstream_error":
    case "timeout":
    case "error":
      return false;
    case "missing_cli":
    case "invalid_credentials":
    case "gateway_unavailable":
    case "state_unavailable":
    case "malformed_response":
    case "profile_unavailable":
    case "groups_unavailable":
      return true;
    default:
      return true;
  }
}

function runtimeSessionId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = record.session_id;
  // session_key is a durable DB lineage identifier.  It is never a substitute
  // for the ephemeral runtime id returned by session.resume.
  return safeOpaqueId(id) ? id : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asHermesError(error: unknown): HermesEngineError {
  if (error instanceof HermesEngineError) return error;
  return new HermesEngineError("upstream_error");
}

function childErrorCode(error: unknown): HermesFailureCode {
  const rawCode = asRecord(error)?.code;
  const code = typeof rawCode === "string" ? rawCode.toUpperCase() : "";
  return code === "ENOENT" || code === "EACCES" ? "missing_cli" : "gateway_unavailable";
}

function canonicalUnknownCode(
  code: HermesFailureCode,
): Extract<HermesCanonicalLookup, { state: "unknown" }>["code"] {
  switch (code) {
    case "missing_cli":
    case "invalid_credentials":
    case "gateway_unavailable":
    case "state_unavailable":
    case "malformed_response":
    case "timeout":
    case "profile_unavailable":
      return code;
    default:
      return "state_unavailable";
  }
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
