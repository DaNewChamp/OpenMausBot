// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { DATA_DIR } from "./data-dir.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import { parseComputerHostId } from "../shared/computer-host.ts";

export { DATA_DIR } from "./data-dir.ts";

const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 4;

/** How the harness handles provider permission requests by default. */
export const PERMISSION_MODES = ["ask", "allow", "deny"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

/** Keep the persisted VPS shape deliberately smaller than an SSH connection. */
export function normalizeVpsConfig(raw: unknown): { sshAlias?: string } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const alias = (raw as Record<string, unknown>).sshAlias;
  if (alias === undefined || alias === "") return {};
  if (!isValidSshAlias(alias)) {
    throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
  }
  return { sshAlias: alias };
}

const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }).optional(),
});
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
});
const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
  /** Fleet machine that hosts the shared (or per-bot) Linux VM. */
  hostId: z.string().regex(/^[\w-]{0,80}$/).optional(),
});
const featureConfigSchema = z.object({
  /** Experimental desktop workflow recorder. Hidden unless explicitly enabled. */
  skillRecorder: z.boolean().optional(),
});
const permissionConfigSchema = z.object({
  /** App-wide default for permission requests. Per-bot overrides win. */
  defaultMode: z.enum(PERMISSION_MODES).optional(),
});
const MAX_HOUSE_STYLE_INSTRUCTIONS = 4_000;
const houseStyleConfigSchema = z.object({
  /** Global voice instructions prepended to every bot's prompt. Absent = on
   * with the shipped default text. */
  enabled: z.boolean().optional(),
  instructions: z.string().max(MAX_HOUSE_STYLE_INSTRUCTIONS).optional(),
});
const APPROVAL_REVIEWER_MODES = ["off", "when-unclear", "always"] as const;
const approvalReviewerConfigSchema = z.object({
  /** When to ask a model to rewrite the display-only approval summary. */
  mode: z.enum(APPROVAL_REVIEWER_MODES).optional(),
  instanceId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(500).optional(),
}).strict();
const vbotConfigSchema = z.object({
  primaryEngine: z.enum(["openmaus", "grokReconstructed"]).optional(),
  hermes: z.object({
    enabled: z.boolean().optional(),
    instanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional(),
  }).strict().optional(),
});
const bridgeSshTargetSchema = z.object({
  bridge: z.string().optional(),
  alias: z.string().refine((value) => isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }),
});
const bridgeSshTargetsSchema = z.record(z.string(), bridgeSshTargetSchema);
const bridgeSshTargetsConfigSchema = bridgeSshTargetsSchema;
const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const appConfigSchema = z.object({
  /** User-configured stdio MCP servers mounted into capable engines. Kept
   * loosely typed so one malformed entry can be skipped without discarding
   * the rest of the persisted configuration. */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  openaiCompat: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Z.ai (GLM Coding Plan) key and optional base-URL override. */
  zai: z.object({ apiKey: optionalText, baseUrl: optionalText }).optional(),
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  /** Optional OpenCode key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText }).optional(),
  /** Voice credentials and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs a key), "system" (the Mac's
   * built-in voices, no key), or "kokoro" (operator-hosted FastAPI). */
  tts: z.object({ key: optionalText, voice: optionalText, provider: z.enum(["elevenlabs", "system", "kokoro"]).optional() }).optional(),
  /** OpenAI key used only by the in-process avatar image generator. */
  imageGen: z.object({ key: optionalText }).optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  rooms: roomConfigSchema.optional(),
  localVm: localVmConfigSchema.optional(),
  features: featureConfigSchema.optional(),
  permissions: permissionConfigSchema.optional(),
  approvalReviewer: approvalReviewerConfigSchema.optional(),
  houseStyle: houseStyleConfigSchema.optional(),
  vbot: vbotConfigSchema.optional(),
  bridgeSshTargets: bridgeSshTargetsConfigSchema.optional(),
  instances: instanceConfigMapSchema.optional(),
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true, mcpServers: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  mcpServers?: Record<string, unknown>;
  xai?: { key?: string; url?: string };
  openaiCompat?: { key?: string; url?: string };
  zai?: { apiKey?: string; baseUrl?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; voice?: string; provider?: "elevenlabs" | "system" | "kokoro" };
  imageGen?: { key?: string };
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. hostId pins the
   * VM to one paired fleet machine for every bot. */
  localVm?: { mode?: "shared" | "per-bot"; maxInstances?: number; hostId?: string };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: { skillRecorder?: boolean };
  /** App-wide permission behavior. Missing means ask every time. */
  permissions?: { defaultMode?: PermissionMode };
  /** Display-only approval summaries. Credentials are never stored here. */
  approvalReviewer?: {
    mode?: "off" | "when-unclear" | "always";
    instanceId?: string;
    model?: string;
  };
  /** Hub-wide voice instructions prepended to every bot's prompt. A bot's
   * own instructions win when they say otherwise (see server/house-style.ts
   * for the opt-out marker). */
  houseStyle?: { enabled?: boolean; instructions?: string };
  /** V Bot engine selection. OpenMaus remains the default fallback. */
  vbot?: {
    primaryEngine?: "openmaus" | "grokReconstructed";
    /** Disabled-by-default local Hermes Bot Chat adapter metadata. */
    hermes?: { enabled?: boolean; instanceId?: string };
  };
  /** Named SSH targets executed through home bridges (alias from ~/.ssh/config). */
  bridgeSshTargets?: Record<string, { bridge?: string; alias: string }>;
  instances?: InstanceConfigMap;
}
export type ConfigPatch = z.output<typeof appConfigPatchSchema>;

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return parsed.data;
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  return parsed.data;
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

export function bridgeSshTarget(
  cfg: AppConfig,
  target: string,
): { bridge?: string; alias: string } | null {
  const entry = cfg.bridgeSshTargets?.[target];
  if (!entry || !isValidSshAlias(entry.alias)) return null;
  return entry;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

/** Paired machine that should host the Linux VM for every bot. */
export function localVmHostId(cfg: AppConfig): string | null {
  const parsed = parseComputerHostId(cfg.localVm?.hostId ?? null);
  if (!parsed.ok) return null;
  return parsed.computerHostId ?? null;
}

export function skillRecorderEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillRecorder === true;
}

/** Return the app-wide permission default, keeping older config files in the
 * safest mode until an owner explicitly chooses another behavior. */
export function defaultPermissionMode(cfg: AppConfig): PermissionMode {
  return cfg.permissions?.defaultMode ?? "ask";
}

/** The shipped global voice instructions. Written to sound the way it asks
 * bots to sound: no em dashes, no AI-isms, no corporate hedging. */
export const DEFAULT_HOUSE_STYLE_INSTRUCTIONS =
  'Sound like a real person talking. Plain words, contractions, short sentences. No em dashes. No AI-isms ("I\'m an AI", "Great question", "As an AI", "I cannot", disclaimers nobody asked for). No emoji unless the person uses them first. Get to the point, answer what was actually asked, and it\'s fine to have a personality.';

/** House style is on unless the hub owner turned it off. */
export function houseStyleEnabled(cfg: AppConfig): boolean {
  return cfg.houseStyle?.enabled !== false;
}

/** The effective global instructions: the saved text when the owner wrote
 * one, otherwise the shipped default. */
export function houseStyleInstructions(cfg: AppConfig): string {
  const saved = cfg.houseStyle?.instructions?.trim();
  return saved ? saved : DEFAULT_HOUSE_STYLE_INSTRUCTIONS;
}

/** Hermes Bot Chat is an opt-in adapter separate from generic Hermes ACP. */
export function hermesBotEnabled(cfg: AppConfig): boolean {
  return cfg.vbot?.hermes?.enabled === true;
}

/** Select the existing Hermes provider instance without exposing any path or
 * executable metadata to clients. */
export function hermesBotInstanceId(cfg: AppConfig): string {
  const value = cfg.vbot?.hermes?.instanceId;
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
    ? value
    : "hermes";
}

const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
  } catch {
    /* first run — env fallbacks below */
  }
  // Env wins over the file for every credential. The desktop shell keeps
  // these secrets OS-encrypted and hands them to this process as env at
  // spawn, leaving config.json without the plaintext field — so the file
  // value is the dev-mode (no desktop shell) fallback, not the primary.
  // Anything that saves a credential mid-session must keep process.env in
  // step (syncCredentialEnv below), or the value injected at boot would
  // shadow the save until the next launch.
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
  cfg.openaiCompat = { ...cfg.openaiCompat };
  if (process.env.OPENAI_COMPAT_API_KEY !== undefined) cfg.openaiCompat.key = process.env.OPENAI_COMPAT_API_KEY;
  if (process.env.OPENAI_COMPAT_URL !== undefined) cfg.openaiCompat.url = process.env.OPENAI_COMPAT_URL;
  cfg.zai = { ...cfg.zai };
  if (process.env.ZAI_API_KEY !== undefined) cfg.zai.apiKey = process.env.ZAI_API_KEY;
  if (process.env.ZAI_BASE_URL !== undefined) cfg.zai.baseUrl = process.env.ZAI_BASE_URL;
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  return cfg;
}

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<AppConfig>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.zai?.apiKey, "ZAI_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  if (patch.openaiCompat?.url !== undefined) {
    if (patch.openaiCompat.url) process.env["OPENAI_COMPAT_URL"] = patch.openaiCompat.url;
    else delete process.env["OPENAI_COMPAT_URL"];
  }
  if (patch.zai?.baseUrl !== undefined) {
    if (patch.zai.baseUrl) process.env["ZAI_BASE_URL"] = patch.zai.baseUrl;
    else delete process.env["ZAI_BASE_URL"];
  }
}

/** Env names of every workspace credential this process may be holding —
 * injected at boot by the desktop shell or exported by a developer. Spawned
 * engine CLIs must never inherit them: the one driver that consumes a given
 * secret receives it through instanceConfigs() narrowing, and to every other
 * child these are someone else's keys riding along in `...process.env`. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "ZAI_API_KEY",
  "ZAI_BASE_URL",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
] as const;

/** Drop every workspace credential from a child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
}

/** Env names a provider CLI might read as its own billing identity. A spawned
 * engine keeps only what its driver explicitly allows: a foreign key riding
 * along in `...process.env` must not flip a subscription CLI onto
 * pay-as-you-go billing the user never granted. */
export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "ZAI_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) disk = parsed.data;
  } catch {
    /* first write */
  }
  const checkedPatch = appConfigSchema.partial().parse(patch);
  for (const key of ["xai", "openaiCompat", "zai", "composio", "box", "opencodeGo", "tts", "imageGen", "profile", "rooms", "localVm", "features", "permissions", "approvalReviewer", "houseStyle", "vbot"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    Object.assign(merged, section);
    disk[key] = merged;
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  if (checkedPatch.bridgeSshTargets !== undefined) disk.bridgeSshTargets = checkedPatch.bridgeSshTargets;
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const diskInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(diskInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into consuming
 * drivers' entries for the live fleet, so those injected keys are stripped
 * back out before the map is returned — otherwise saving an override would
 * copy xai/box/opencodeGo secrets into the instances section of
 * config.json. */
export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = instanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  const entry = map[instanceId];
  const cliKey = cli.trim();
  const currentConfig = jsonObjectSchema.safeParse(entry.config);
  if (cliKey) {
    const nextConfig: JsonObject = currentConfig.success ? { ...currentConfig.data } : {};
    nextConfig.cli = cliKey;
    entry.config = nextConfig;
  } else if (currentConfig.success && Object.hasOwn(currentConfig.data, "cli")) {
    const rest = { ...currentConfig.data };
    delete rest.cli;
    entry.config = Object.keys(rest).length ? rest : undefined;
  }
  for (const e of Object.values(map)) {
    if (!e.environment) continue;
    const injected = injectedEnvironment(next, e.driver);
    for (const [k, v] of Object.entries(e.environment)) {
      if (injected.get(k) === v) delete e.environment[k];
    }
    if (!Object.keys(e.environment).length) delete e.environment;
  }
  next.instances = map;
  return { ok: true, config: next };
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects for one driver — shared with
 * withInstanceCli() so the inject rule and the strip rule cannot drift apart.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  if (driver === "openai-compat" && cfg.openaiCompat?.key)
    environment.set("OPENAI_COMPAT_API_KEY", cfg.openaiCompat.key);
  if (driver === "openai-compat" && cfg.openaiCompat?.url)
    environment.set("OPENAI_COMPAT_URL", cfg.openaiCompat.url);
  if (driver === "zai" && cfg.zai?.apiKey) environment.set("ZAI_API_KEY", cfg.zai.apiKey);
  if (driver === "zai" && cfg.zai?.baseUrl) environment.set("ZAI_BASE_URL", cfg.zai.baseUrl);
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo" && cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  return environment;
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars — but only into the
// driver that consumes each key (injectedEnvironment above).
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime. `grokReconstructed` is a separate local adapter for a
  // running Grok Bot 0.18 Reconstructed desktop app; it does not replace
  // grokAgent and stays unavailable until that app is detected on loopback.
  //
  // Google rides `antigravityAgent` (the `agy` CLI), not `geminiAgent`:
  // Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18
  // (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
  // CLI"), so a default `gemini` instance could only ever show unavailable.
  // The driver stays registered for enterprise licences, which keep Gemini
  // CLI — `{"instances": {"gemini": {"driver": "geminiAgent"}}}` restores it.
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    kimi: { driver: "kimiAgent" },
    droid: { driver: "droidAgent" },
    cursor: { driver: "cursorAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    antigravity: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    openaiCompat: { driver: "openai-compat" },
    grokReconstructed: { driver: "grokReconstructed" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
    zai: { driver: "zai" },
  };
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    grokReconstructed: { driver: "grokReconstructed" },
    zai: { driver: "zai" },
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
  // Product fleets pick up newly shipped engines. A one-off test/shadow map
  // (no claude/grok/codex) is left exactly as written.
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(PRODUCT_FLEET_ADDITIONS)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  for (const [id, sourceEntry] of Object.entries(map)) {
    // instanceConfigs() builds a transient runtime map. Never mutate the
    // caller's persisted entries while injecting workspace defaults: doing so
    // would turn the first workspace URL into a stale per-instance override.
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    for (const [key, value] of injectedEnvironment(cfg, entry.driver)) environment[key] = value;
    entry.environment = environment;
    // The driver URL is configuration, not a credential. Environment is
    // intentionally not consulted by ProviderRegistry when it decodes a
    // driver's config, so carry the workspace default into the transient
    // instance map while preserving a per-instance override.
    if (entry.driver === "openai-compat" && cfg.openaiCompat?.url) {
      const raw = entry.config;
      if (raw === undefined) {
        entry.config = { url: cfg.openaiCompat.url };
      } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const current = raw as Record<string, unknown>;
        if (typeof current.url !== "string" || !current.url.trim()) {
          entry.config = { ...current, url: cfg.openaiCompat.url };
        }
      }
    }
    if (entry.driver === "zai" && cfg.zai?.baseUrl) {
      const raw = entry.config;
      if (raw === undefined) {
        entry.config = { baseUrl: cfg.zai.baseUrl };
      } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const current = raw as Record<string, unknown>;
        if (typeof current.baseUrl !== "string" || !current.baseUrl.trim()) {
          entry.config = { ...current, baseUrl: cfg.zai.baseUrl };
        }
      }
    }
  }
  return map;
}

// ── user-configured MCP servers ─────────────────────────────────────────
// stdio only for now. Invalid entries are skipped individually so one bad
// server cannot take down the fleet; the diagnostic doubles as a setup hint.
export interface CustomMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const customMcpEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
}).strict();
const CUSTOM_MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_MCP_NAMES = new Set([
  "ogb", "computer", "agents", "composio", "browser", "phone", "dweb",
  "openmausbot_connectors", "openmausbot_phone",
]);
const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

/** Validated custom stdio MCP servers from config, or an empty map. */
export function customMcpServers(cfg: AppConfig): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (!CUSTOM_MCP_NAME.test(name)) {
      skipMcpEntry(name, "server names are lowercase letters, digits, _ or - (max 32 chars), starting with a letter");
      continue;
    }
    if (RESERVED_MCP_NAMES.has(name)) {
      skipMcpEntry(name, "that name is reserved for a built-in server — pick another");
      continue;
    }
    if (raw && typeof raw === "object" && "url" in raw) {
      skipMcpEntry(name, 'only stdio servers ("command") are supported so far');
      continue;
    }
    const parsed = customMcpEntrySchema.safeParse(raw);
    if (!parsed.success) {
      skipMcpEntry(name, `invalid entry (${parsed.error.issues[0]?.message ?? "schema mismatch"}) — expected { "command": "npx", "args": [...], "env": { ... } }`);
      continue;
    }
    if (parsed.data.enabled === false) continue;
    out[name] = {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env: parsed.data.env ?? {},
    };
  }
  return out;
}
