// Local-only adapter for the unofficial Grok Bot 0.18 reconstructed desktop
// app. OpenMausBot remains the authenticated control plane: iOS and the
// companion sidecar never receive reconstructed loopback ports, discovery
// tokens, or host paths. This driver talks to the reconstructed gateway only
// on 127.0.0.1. Detection verifies GET /health and POST /api/listAgents.
// A send uses only POST /api/sendPrompt and POST /api/getAgentTranscriptTail.
// Undocumented routes, including /events, are not probed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

export const DRIVER_KIND = "grokReconstructed";
export const RECONSTRUCTED_BUNDLE_ID = "com.anysphere.sand.reconstructed";
export const RECONSTRUCTED_APP_NAME = "Grok Bot 0.18 Reconstructed";
export const ACTIVE_SESSION_ID = "active";
export const GATEWAY_AUTH_SCHEME = "Bearer";
export const GATEWAY_API_PREFIX = "/api";
export const GATEWAY_HEALTH_PATH = "/health";
export const STABLE_GATEWAY_METHODS = ["listAgents", "sendPrompt", "getAgentTranscriptTail"] as const;
export type StableGatewayMethod = (typeof STABLE_GATEWAY_METHODS)[number];

const STABLE_GATEWAY_METHOD_SET = new Set<string>(STABLE_GATEWAY_METHODS);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const GATEWAY_DISCOVERY_FILE = "gateway.json";
const SAND_DATA_DIRNAME = "sand-data";
const AGENT_ID = /^[\w.-]{1,200}$/;
const LABEL_MAX = 120;
const HEALTH_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
const SETTLE_MS = 1_500;
const CACHE_MS = 2_000;

const FALLBACK_MODELS: ModelCatalog = {
  default: ACTIVE_SESSION_ID,
  options: [{ id: ACTIVE_SESSION_ID, label: "Active reconstructed bot" }],
};

export type ReconstructedDisabledCode =
  | "not-detected"
  | "installed-not-running"
  | "runtime-not-reconstructed"
  | "discovery-unreadable"
  | "non-loopback-refused"
  | "process-dead"
  | "health-unavailable"
  | "identity-mismatch"
  | "list-agents-unsupported"
  | "send-prompt-unsupported";

export interface GatewayDiscovery {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: number;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly token: string | null;
}

export interface ReconstructedSession {
  readonly id: string;
  readonly label: string;
  readonly isRunning?: boolean;
  readonly isActive?: boolean;
}

export interface ReconstructedCapabilities {
  readonly health: boolean;
  readonly listAgents: boolean;
  readonly sendPrompt: boolean;
  readonly events: boolean;
  readonly transcriptTail: boolean;
}

export interface ReconstructedRuntimeHost {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly applicationsDirs: readonly string[];
  readText(path: string): string | null;
  existsDir(path: string): boolean;
  isProcessAlive(pid: number): boolean;
  readProcessCommand(pid: number): string | null;
  fetch: typeof fetch;
  delay(ms: number): Promise<void>;
  now(): number;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function publicDisabledReason(code: ReconstructedDisabledCode): string {
  switch (code) {
    case "not-detected":
      return "Grok Bot 0.18 Reconstructed was not found on this computer.";
    case "installed-not-running":
      return "Grok Bot 0.18 Reconstructed is installed but not running. Open that desktop app to enable this engine.";
    case "runtime-not-reconstructed":
      return "A local Grok Bot host is running, but it is not the 0.18 reconstructed app.";
    case "discovery-unreadable":
      return "The reconstructed app is running, but its local discovery record was unreadable.";
    case "non-loopback-refused":
      return "The reconstructed host advertised a non-loopback address and was refused.";
    case "process-dead":
      return "The reconstructed local gateway process is no longer running.";
    case "health-unavailable":
      return "The reconstructed local gateway did not answer /health.";
    case "identity-mismatch":
      return "The reconstructed gateway identity did not match local discovery.";
    case "list-agents-unsupported":
      return "The reconstructed local gateway does not expose listAgents.";
    case "send-prompt-unsupported":
      return "The reconstructed local gateway does not expose sendPrompt.";
  }
}

export function parseGatewayDiscovery(value: unknown): GatewayDiscovery | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port < 1 || v.port > 65_535) {
    return null;
  }
  if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0) return null;
  if (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt)) return null;
  const scheme = v.scheme === undefined ? "http" : v.scheme;
  if (scheme !== "http" && scheme !== "https") return null;
  const host = v.host === undefined ? "127.0.0.1" : v.host;
  if (typeof host !== "string" || host.trim().length === 0) return null;
  if (v.token !== undefined && typeof v.token !== "string") return null;
  const token = typeof v.token === "string" && v.token.length > 0 ? v.token : null;
  return { port: v.port, pid: v.pid, startedAt: v.startedAt, scheme, host: host.trim(), token };
}

export function reconstructedDiscoveryPath(homeDir: string): string {
  return join(homeDir, ".grokbot", GATEWAY_DISCOVERY_FILE);
}

function reconstructedAppDataDir(homeDir: string, platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
      return join(homeDir, "Library", "Application Support");
    case "win32":
      return join(homeDir, "AppData", "Roaming");
    case "linux":
      return join(homeDir, ".config");
    default:
      return null;
  }
}

export function reconstructedIsolatedDiscoveryPath(
  homeDir: string,
  platform: NodeJS.Platform,
): string | null {
  const appDataDir = reconstructedAppDataDir(homeDir, platform);
  if (appDataDir == null) return null;
  return join(appDataDir, RECONSTRUCTED_APP_NAME, SAND_DATA_DIRNAME, GATEWAY_DISCOVERY_FILE);
}

/** Bounded local discovery candidates. Isolated packaged Electron userData
 * comes first so a live reconstructed app is not shadowed by a leftover
 * `~/.grokbot` record. The first present file wins; a present-but-unusable
 * record fails closed instead of scanning the rest. */
export function reconstructedDiscoveryPaths(
  homeDir: string,
  platform: NodeJS.Platform,
): readonly string[] {
  const isolated = reconstructedIsolatedDiscoveryPath(homeDir, platform);
  const legacy = reconstructedDiscoveryPath(homeDir);
  return isolated ? [isolated, legacy] : [legacy];
}

function firstPresentDiscoveryText(
  host: ReconstructedRuntimeHost,
): { path: string; raw: string } | null {
  for (const path of reconstructedDiscoveryPaths(host.homeDir, host.platform)) {
    const raw = host.readText(path);
    if (raw != null) return { path, raw };
  }
  return null;
}

export function isReconstructedProcessCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  return command.includes(RECONSTRUCTED_APP_NAME) || command.includes(RECONSTRUCTED_BUNDLE_ID);
}

export function bundleIdFromInfoPlist(text: string): string | null {
  const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
  return match?.[1]?.trim() || null;
}

export interface SyncedReconstructedBot {
  readonly id: string;
  readonly label: string;
  readonly isActive?: boolean;
  readonly isRunning?: boolean;
}

export interface SyncedReconstructedGroup {
  readonly id: string;
  readonly label: string;
  readonly memberIds: readonly string[];
  readonly isActive?: boolean;
}

export function projectReconstructedRoster(value: unknown): {
  readonly bots: SyncedReconstructedBot[];
  readonly groups: SyncedReconstructedGroup[];
} {
  if (!Array.isArray(value)) return { bots: [], groups: [] };
  const bots: SyncedReconstructedBot[] = [];
  const groups: SyncedReconstructedGroup[] = [];
  const seen = new Set<string>([ACTIVE_SESSION_ID]);
  for (const row of value) {
    if (typeof row !== "object" || row == null || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!AGENT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    let label = "";
    for (const char of name || title || id) {
      if (char.charCodeAt(0) >= 32) label += char;
    }
    label = label.slice(0, LABEL_MAX);
    const finalLabel = label.length > 0 ? label : id;
    if (rec.isGroup === true) {
      const memberIds: string[] = [];
      if (Array.isArray(rec.memberIds)) {
        for (const member of rec.memberIds) {
          if (typeof member !== "string") continue;
          const trimmed = member.trim();
          if (!AGENT_ID.test(trimmed) || memberIds.includes(trimmed)) continue;
          memberIds.push(trimmed);
        }
      }
      groups.push({
        id,
        label: finalLabel,
        memberIds,
        ...(typeof rec.isActive === "boolean" ? { isActive: rec.isActive } : {}),
      });
      continue;
    }
    bots.push({
      id,
      label: finalLabel,
      ...(typeof rec.isRunning === "boolean" ? { isRunning: rec.isRunning } : {}),
      ...(typeof rec.isActive === "boolean" ? { isActive: rec.isActive } : {}),
    });
  }
  return { bots, groups };
}

export interface SyncedReconstructedRoster {
  readonly bots: SyncedReconstructedBot[];
  readonly groups: SyncedReconstructedGroup[];
}

export type ReconstructedProbe =
  | {
      readonly ok: true;
      readonly discovery: GatewayDiscovery;
      readonly origin: string;
      readonly token: string | null;
      readonly sessions: ReconstructedSession[];
      readonly roster: SyncedReconstructedRoster;
      readonly capabilities: ReconstructedCapabilities;
    }
  | { readonly ok: false; readonly code: ReconstructedDisabledCode };

export function sanitizeAgentSessions(value: unknown): ReconstructedSession[] {
  if (!Array.isArray(value)) return [];
  const sessions: ReconstructedSession[] = [];
  const seen = new Set<string>([ACTIVE_SESSION_ID]);
  for (const row of value) {
    if (typeof row !== "object" || row == null || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!AGENT_ID.test(id) || seen.has(id)) continue;
    if (rec.isGroup === true) continue;
    seen.add(id);
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    let label = "";
    for (const char of name || title || id) {
      if (char.charCodeAt(0) >= 32) label += char;
    }
    label = label.slice(0, LABEL_MAX);
    const session: { id: string; label: string; isRunning?: boolean; isActive?: boolean } = {
      id,
      label: label.length > 0 ? label : id,
    };
    if (typeof rec.isRunning === "boolean") session.isRunning = rec.isRunning;
    if (typeof rec.isActive === "boolean") session.isActive = rec.isActive;
    sessions.push(session);
  }
  return sessions;
}

export function sessionsToCatalog(sessions: readonly ReconstructedSession[]): ModelCatalog {
  const options = [
    ...FALLBACK_MODELS.options,
    ...sessions.map((session) => ({ id: session.id, label: session.label })),
  ];
  const active = sessions.find((session) => session.isActive);
  return { default: active?.id ?? ACTIVE_SESSION_ID, options };
}

export function extractAssistantText(entries: unknown, afterPrompt?: string): string {
  if (!Array.isArray(entries)) return "";
  let start = 0;
  if (afterPrompt) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (typeof entry !== "object" || entry == null) continue;
      const rec = entry as Record<string, unknown>;
      if (rec.kind === "message" && typeof rec.content === "string" && rec.content === afterPrompt) {
        start = i + 1;
        break;
      }
    }
  }
  const parts: string[] = [];
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "object" || entry == null) continue;
    const rec = entry as Record<string, unknown>;
    if (rec.kind !== "send-message") continue;
    const message = rec.message && typeof rec.message === "object" ? (rec.message as Record<string, unknown>) : null;
    if (message?.type !== "text" || typeof message.content !== "string" || message.content.length === 0) continue;
    if (afterPrompt && message.content === afterPrompt) continue;
    parts.push(message.content);
  }
  return parts.join("");
}

export function leaksSensitive(text: string, secrets: readonly string[]): boolean {
  const lower = text.toLowerCase();
  if (secrets.some((secret) => secret && text.includes(secret))) return true;
  if (lower.includes("gateway.json") || lower.includes(".grokbot") || lower.includes("sand-data")) return true;
  if (/\b(?:127\.0\.0\.1|localhost):\d{2,5}\b/.test(text)) return true;
  if (/\bBearer\s+\S+/i.test(text)) return true;
  return false;
}

export function safePublicError(error: unknown, secrets: readonly string[] = []): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (leaksSensitive(raw, secrets)) return "The reconstructed local gateway request failed.";
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : "The reconstructed local gateway request failed.";
}

function originFor(discovery: GatewayDiscovery): string | null {
  if (!isLoopbackHost(discovery.host)) return null;
  const origin = `${discovery.scheme}://127.0.0.1:${discovery.port}`;
  return isAllowedLoopbackOrigin(origin) ? origin : null;
}

export function isAllowedLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname !== "127.0.0.1") return false;
    if (url.username || url.password) return false;
    if (url.port.length === 0) return false;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function isAllowedLoopbackRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isAllowedLoopbackOrigin(parsed.origin) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function defaultReadProcessCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
  } catch {
    return null;
  }
}

export function defaultReconstructedHost(
  overrides: Partial<ReconstructedRuntimeHost> = {},
): ReconstructedRuntimeHost {
  const homeDir = overrides.homeDir ?? homedir();
  const platform = overrides.platform ?? process.platform;
  return {
    homeDir,
    platform,
    applicationsDirs:
      overrides.applicationsDirs ??
      (platform === "darwin" ? ["/Applications", join(homeDir, "Applications")] : []),
    readText:
      overrides.readText ??
      ((path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      }),
    existsDir: overrides.existsDir ?? ((path) => existsSync(path)),
    isProcessAlive:
      overrides.isProcessAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    readProcessCommand: overrides.readProcessCommand ?? defaultReadProcessCommand,
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
    delay: overrides.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? Date.now,
  };
}

export function detectReconstructedInstall(host: ReconstructedRuntimeHost): boolean {
  for (const dir of host.applicationsDirs) {
    const appPath = join(dir, `${RECONSTRUCTED_APP_NAME}.app`);
    if (!host.existsDir(appPath)) continue;
    const plist = host.readText(join(appPath, "Contents", "Info.plist"));
    if (plist) {
      const bundleId = bundleIdFromInfoPlist(plist);
      if (bundleId != null && bundleId !== RECONSTRUCTED_BUNDLE_ID) continue;
    }
    return true;
  }
  return false;
}

export function readLocalDiscovery(host: ReconstructedRuntimeHost): GatewayDiscovery | null {
  const present = firstPresentDiscoveryText(host);
  if (present == null) return null;
  try {
    return parseGatewayDiscovery(JSON.parse(present.raw));
  } catch {
    return null;
  }
}

async function readJson(
  host: ReconstructedRuntimeHost,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; value: unknown; text: string }> {
  if (!isAllowedLoopbackRequestUrl(url)) {
    throw new Error("refused non-loopback reconstructed request");
  }
  const res = await host.fetch(url, { ...init, redirect: "error" });
  const text = await res.text().catch(() => "");
  let value: unknown = null;
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
  }
  return { ok: res.ok, status: res.status, value, text };
}

function requestHeaders(token: string | null | undefined, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-sand-slim-avatars": "1",
    ...extra,
  };
  if (token) headers.authorization = `${GATEWAY_AUTH_SCHEME} ${token}`;
  return headers;
}

export async function probeReconstructedGateway(
  host: ReconstructedRuntimeHost,
  discovery: GatewayDiscovery,
): Promise<ReconstructedProbe> {
  if (!host.isProcessAlive(discovery.pid)) return { ok: false, code: "process-dead" };
  const command = host.readProcessCommand(discovery.pid);
  if (!isReconstructedProcessCommand(command)) return { ok: false, code: "runtime-not-reconstructed" };
  const origin = originFor(discovery);
  if (origin == null) return { ok: false, code: "non-loopback-refused" };

  const secrets = [
    discovery.token,
    origin,
    ...reconstructedDiscoveryPaths(host.homeDir, host.platform),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  try {
    const health = await readJson(host, `${origin}${GATEWAY_HEALTH_PATH}`, {
      method: "GET",
      headers: requestHeaders(discovery.token),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!health.ok || typeof health.value !== "object" || health.value == null) {
      return { ok: false, code: "health-unavailable" };
    }
    const healthPid = (health.value as Record<string, unknown>).pid;
    if (typeof healthPid === "number" && healthPid !== discovery.pid) {
      return { ok: false, code: "identity-mismatch" };
    }

    const listed = await readJson(host, `${origin}${GATEWAY_API_PREFIX}/listAgents`, {
      method: "POST",
      headers: requestHeaders(discovery.token, { "content-type": "application/json" }),
      body: "{}",
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
    if (!listed.ok || !Array.isArray(listed.value)) {
      return { ok: false, code: "list-agents-unsupported" };
    }

    return {
      ok: true,
      discovery,
      origin,
      token: discovery.token,
      sessions: sanitizeAgentSessions(listed.value),
      roster: projectReconstructedRoster(listed.value),
      capabilities: {
        health: true,
        listAgents: true,
        sendPrompt: false,
        events: false,
        transcriptTail: false,
      },
    };
  } catch (error) {
    appendNative("grok-reconstructed", {
      dir: "in",
      source: "grok-reconstructed.probe",
      msg: { failed: true, message: safePublicError(error, secrets) },
    });
    return { ok: false, code: "health-unavailable" };
  }
}

export async function detectReconstructedRuntime(host: ReconstructedRuntimeHost): Promise<ReconstructedProbe> {
  const installed = detectReconstructedInstall(host);
  const present = firstPresentDiscoveryText(host);
  if (present == null) {
    return { ok: false, code: installed ? "installed-not-running" : "not-detected" };
  }
  let discovery: GatewayDiscovery | null = null;
  try {
    discovery = parseGatewayDiscovery(JSON.parse(present.raw));
  } catch {
    discovery = null;
  }
  if (discovery == null) return { ok: false, code: "discovery-unreadable" };
  if (!isLoopbackHost(discovery.host)) return { ok: false, code: "non-loopback-refused" };
  if (!host.isProcessAlive(discovery.pid)) {
    return { ok: false, code: installed ? "installed-not-running" : "process-dead" };
  }
  if (!isReconstructedProcessCommand(host.readProcessCommand(discovery.pid))) {
    return { ok: false, code: "runtime-not-reconstructed" };
  }
  return probeReconstructedGateway(host, discovery);
}

async function waitFor(signal: AbortSignal, delay: (ms: number) => Promise<void>, ms: number): Promise<void> {
  if (signal.aborted) {
    const error = new Error("interrupted");
    error.name = "AbortError";
    throw error;
  }
  await Promise.race([
    delay(ms),
    new Promise<never>((_, reject) => {
      const onAbort = () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
}

export function createGrokReconstructedDriver(
  hostOverrides: Partial<ReconstructedRuntimeHost> = {},
): ProviderDriver<Record<string, never>> {
  const host = defaultReconstructedHost(hostOverrides);

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: "Grok Reconstructed",
      access: "custom",
    },
    models: FALLBACK_MODELS,
    install: {
      docsUrl: "https://github.com/milind-soni/OpenMausBot/blob/main/docs/grok-reconstructed.md",
    },
    decodeConfig: () => ({}),
    defaultConfig: () => ({}),

    async create(input: DriverCreateInput<Record<string, never>>): Promise<ProviderInstance> {
      const { instanceId } = input;
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { abort: AbortController; turnId: string }>();
      let catalog = FALLBACK_MODELS;
      let cached: { at: number; probe: ReconstructedProbe } | null = null;

      const emit = (event: RuntimeEvent) => {
        for (const listener of Array.from(listeners)) listener(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const probe = async (force = false): Promise<ReconstructedProbe> => {
        const now = host.now();
        if (!force && cached && now - cached.at < CACHE_MS) return cached.probe;
        const next = await detectReconstructedRuntime(host);
        cached = { at: now, probe: next };
        if (next.ok) catalog = sessionsToCatalog(next.sessions);
        else catalog = FALLBACK_MODELS;
        return next;
      };

      const command = async (
        runtime: Extract<ReconstructedProbe, { ok: true }>,
        method: StableGatewayMethod,
        body: unknown,
        timeoutMs = COMMAND_TIMEOUT_MS,
        signal?: AbortSignal,
      ): Promise<unknown> => {
        if (!STABLE_GATEWAY_METHOD_SET.has(method)) {
          throw new Error("The reconstructed adapter does not call undocumented gateway methods.");
        }
        if (!isAllowedLoopbackOrigin(runtime.origin)) {
          throw new Error("refused non-loopback reconstructed request");
        }
        const secrets = [runtime.token, runtime.origin].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const result = await readJson(host, `${runtime.origin}${GATEWAY_API_PREFIX}/${method}`, {
          method: "POST",
          headers: requestHeaders(runtime.token, { "content-type": "application/json" }),
          body: JSON.stringify(body ?? {}),
          signal: combined,
        });
        if (!result.ok) {
          const error = new Error(
            result.status === 404
              ? method === "sendPrompt"
                ? publicDisabledReason("send-prompt-unsupported")
                : `The reconstructed local gateway does not expose ${method}.`
              : safePublicError(new Error(`gateway ${method} failed`), secrets),
          ) as Error & { status?: number; method?: string };
          error.status = result.status;
          error.method = method;
          throw error;
        }
        return result.value;
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const detected = await probe();
        if (!detected.ok) {
          return {
            state: "unavailable",
            reason: publicDisabledReason(detected.code ?? "not-detected"),
            authenticated: false,
            version: "0.18-reconstructed",
          };
        }
        return {
          state: "available",
          authenticated: true,
          version: "0.18-reconstructed",
        };
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const detected = await probe(true);
        if (!detected.ok) {
          const reason = publicDisabledReason(detected.code);
          throw Object.assign(new Error(reason), { setup: true });
        }
        if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

        const turnId = newId();
        const abort = new AbortController();
        active.set(turn.threadId, { abort, turnId });
        const model = turn.model && turn.model !== ACTIVE_SESSION_ID ? turn.model : undefined;
        const requestedId = model && AGENT_ID.test(model) ? model : undefined;
        const agentId =
          requestedId ??
          detected.sessions?.find((session) => session.isActive)?.id ??
          detected.sessions?.[0]?.id;
        const prompt = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
        const secrets = [detected.token, detected.origin].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );

        emit({ ...base(turn.threadId, turnId), type: "turn.started" });
        emit({
          ...base(turn.threadId, turnId),
          type: "session.started",
          sessionId: agentId ?? null,
          model: agentId ?? ACTIVE_SESSION_ID,
        });

        appendNative(turn.threadId, {
          dir: "out",
          source: "grok-reconstructed.sendPrompt",
          msg: { method: "sendPrompt", hasAgentId: Boolean(agentId), promptLength: prompt.length },
        });

        void (async () => {
          try {
            const accepted = await command(
              detected,
              "sendPrompt",
              {
                prompt,
                ...(agentId ? { agentId } : {}),
              },
              COMMAND_TIMEOUT_MS,
              abort.signal,
            );
            if (typeof accepted !== "object" || accepted == null || (accepted as { accepted?: unknown }).accepted !== true) {
              throw new Error("The reconstructed host did not accept the prompt.");
            }

            let lastText = "";
            let lastGrowth = host.now();
            const deadline = host.now() + STREAM_TIMEOUT_MS;
            let sawRunning = false;

            while (host.now() < deadline) {
              const tail = await command(
                detected,
                "getAgentTranscriptTail",
                { id: agentId ?? requestedId, limit: 40 },
                COMMAND_TIMEOUT_MS,
                abort.signal,
              ).catch((error: unknown) => {
                if ((error as Error).name === "AbortError") throw error;
                if ((error as { status?: number }).status === 404) return { unsupported: true as const };
                return null;
              });
              if (tail && typeof tail === "object" && "unsupported" in tail) break;
              const entries =
                tail && typeof tail === "object" && Array.isArray((tail as { entries?: unknown }).entries)
                  ? (tail as { entries: unknown[] }).entries
                  : [];
              const text = extractAssistantText(entries, prompt);
              if (text.length > lastText.length) {
                const delta = text.slice(lastText.length);
                lastText = text;
                lastGrowth = host.now();
                emit({
                  ...base(turn.threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta,
                });
              }

              const roster = await command(detected, "listAgents", {}, COMMAND_TIMEOUT_MS, abort.signal).catch(
                (error: unknown) => {
                  if ((error as Error).name === "AbortError") throw error;
                  return null;
                },
              );
              const sessions = sanitizeAgentSessions(roster);
              const current = agentId
                ? sessions.find((session) => session.id === agentId)
                : sessions.find((session) => session.isActive) ?? sessions[0];
              if (current?.isRunning === true) sawRunning = true;
              const settled = sawRunning && current?.isRunning === false;
              const idle = lastText.length > 0 && host.now() - lastGrowth >= SETTLE_MS && current?.isRunning !== true;
              if (settled || idle) break;
              await waitFor(abort.signal, host.delay, POLL_MS);
            }

            if (!lastText.trim()) {
              throw new Error("The reconstructed host did not return a reply before the turn timed out.");
            }
            emit({
              ...base(turn.threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: lastText,
            });
            appendNative(turn.threadId, {
              dir: "in",
              source: "grok-reconstructed.sendPrompt",
              msg: { textLength: lastText.length, accepted: true },
            });
            active.delete(turn.threadId);
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.completed",
              ok: true,
              stopReason: null,
              cost: null,
            });
          } catch (error) {
            active.delete(turn.threadId);
            const aborted = (error as Error).name === "AbortError";
            if (!aborted) {
              emit({
                ...base(turn.threadId, turnId),
                type: "runtime.error",
                message: safePublicError(error, secrets),
                ...((error as { setup?: boolean }).setup ? { setup: true } : {}),
              });
            }
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: aborted ? "interrupted" : "error",
              cost: null,
            });
          }
        })();

        return { turnId };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return catalog;
        },
        refreshModels: async () => {
          await probe(true);
        },
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "in-session",
            agentsMcp: false,
            computerMcp: false,
            composioMcp: false,
            phoneMcp: false,
            images: false,
            queueing: false,
            localComputerMcp: false,
          },
          sendTurn,
          interruptTurn: async (threadId) => {
            active.get(threadId)?.abort.abort();
          },
          respondToRequest: async () => "unavailable" as const,
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { abort } of active.values()) abort.abort();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          for (const { abort } of active.values()) abort.abort();
          listeners.clear();
        },
      };
    },
  };
}

export const GrokReconstructedDriver = createGrokReconstructedDriver();
