import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
} from "./contracts.ts";

const DEFAULT_BINDINGS_FILE = "hermes-bindings.json";
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_PROFILE_LENGTH = 64;
const MAX_BOT_ID_LENGTH = 256;
const POSIX = process.platform !== "win32";

export type BindingStoreResult<T> =
  | { state: "available"; value: T }
  | {
      state: "unavailable";
      code: "state_unavailable" | "malformed_response";
      message: string;
    };

interface BindingSidecar {
  version: 1;
  bindings: Record<string, HermesBotBinding>;
}

function failure(
  code: "state_unavailable" | "malformed_response",
): Extract<BindingStoreResult<never>, { state: "unavailable" }> {
  const error = new HermesEngineError(code);
  return { state: "unavailable", code, message: error.message };
}

function targetPath(path?: string): string | undefined {
  if (path === undefined) return resolve(DATA_DIR, DEFAULT_BINDINGS_FILE);
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) return undefined;
  return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBotId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BOT_ID_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f\u0080-\u009f/\\]/.test(value) &&
    value !== "." &&
    value !== ".." &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

function validProfile(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROFILE_LENGTH) return false;
  if (value.trim() !== value || !PROFILE_PATTERN.test(value)) return false;
  if (/^session(?:[-_]|$)/i.test(value) || /^(?:root|resolved)[-_]?session/i.test(value)) return false;
  if (/^[0-9a-f]{16,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(value)) return false;
  return true;
}

function validBinding(value: unknown): value is HermesBotBinding {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.join("\u0000") !== ["adapter", "bindingVersion", "canonicalTitle", "profile"].join("\u0000")) {
    return false;
  }
  if (!["adapter", "bindingVersion", "canonicalTitle", "profile"].every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return false;
  }
  return (
    value.adapter === "hermesBot" &&
    value.canonicalTitle === "Bot Chat" &&
    value.bindingVersion === 1 &&
    validProfile(value.profile)
  );
}

function canonicalBinding(value: HermesBotBinding): HermesBotBinding {
  return {
    adapter: "hermesBot",
    profile: value.profile.toLowerCase(),
    canonicalTitle: "Bot Chat",
    bindingVersion: 1,
  };
}

function parseSidecar(raw: unknown): Map<string, HermesBotBinding> | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys.join("\u0000") !== "bindings\u0000version") return undefined;
  if (raw.version !== 1 || !isRecord(raw.bindings)) return undefined;

  const bindings = new Map<string, HermesBotBinding>();
  for (const [botId, binding] of Object.entries(raw.bindings)) {
    if (!validBotId(botId) || !validBinding(binding)) return undefined;
    bindings.set(botId, canonicalBinding(binding));
  }
  return bindings;
}

function ensureParent(parent: string, create: boolean): boolean {
  let before;
  try {
    before = lstatSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) return false;
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      before = lstatSync(parent);
    } catch {
      return false;
    }
  }

  if (!before.isDirectory() || before.isSymbolicLink()) return false;
  if (POSIX && typeof process.getuid === "function" && before.uid !== process.getuid()) return false;
  if (POSIX && (before.mode & 0o1002) === 0o1002) return false;

  try {
    if (POSIX) chmodSync(parent, 0o700);
    const after = lstatSync(parent);
    return (
      after.isDirectory() &&
      !after.isSymbolicLink() &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      (!POSIX || (after.mode & 0o777) === 0o700)
    );
  } catch {
    return false;
  }
}

function ensureExistingFile(path: string): "missing" | "ok" | "unavailable" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unavailable";
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return "unavailable";
  if (POSIX && (stat.mode & 0o400) === 0) return "unavailable";
  return "ok";
}

function loadFromPath(path: string): BindingStoreResult<ReadonlyMap<string, HermesBotBinding>> {
  const parent = dirname(path);
  if (!ensureParent(parent, false)) {
    try {
      if (lstatSync(parent).isDirectory()) return failure("state_unavailable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failure("state_unavailable");
      return { state: "available", value: new Map() };
    }
    return failure("state_unavailable");
  }

  const state = ensureExistingFile(path);
  if (state === "missing") return { state: "available", value: new Map() };
  if (state !== "ok") return failure("state_unavailable");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return failure("malformed_response");
  }
  const bindings = parseSidecar(parsed);
  return bindings ? { state: "available", value: bindings } : failure("malformed_response");
}

function writeBindings(path: string, bindings: ReadonlyMap<string, HermesBotBinding>): BindingStoreResult<void> {
  if (!ensureParent(dirname(path), true)) return failure("state_unavailable");
  const existing = ensureExistingFile(path);
  if (existing === "unavailable") return failure("state_unavailable");

  const diskBindings: Record<string, HermesBotBinding> = Object.create(null) as Record<string, HermesBotBinding>;
  for (const [botId, binding] of [...bindings.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    diskBindings[botId] = canonicalBinding(binding);
  }
  const sidecar: BindingSidecar = { version: 1, bindings: diskBindings };
  try {
    writeFileAtomic(path, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
    const written = lstatSync(path);
    if (!written.isFile() || written.isSymbolicLink() || (POSIX && (written.mode & 0o777) !== 0o600)) {
      return failure("state_unavailable");
    }
  } catch {
    return failure("state_unavailable");
  }
  return { state: "available", value: undefined };
}

export function loadHermesBindings(path?: string): BindingStoreResult<ReadonlyMap<string, HermesBotBinding>> {
  const resolved = targetPath(path);
  return resolved ? loadFromPath(resolved) : failure("state_unavailable");
}

export function setHermesBinding(
  botId: string,
  binding: HermesBotBinding,
  path?: string,
): BindingStoreResult<void> {
  const resolved = targetPath(path);
  if (!resolved || !validBotId(botId) || !validBinding(binding)) return failure("malformed_response");
  const loaded = loadFromPath(resolved);
  if (loaded.state === "unavailable") return loaded;
  const next = new Map(loaded.value);
  next.set(botId, canonicalBinding(binding));
  return writeBindings(resolved, next);
}

export function removeHermesBinding(botId: string, path?: string): BindingStoreResult<void> {
  const resolved = targetPath(path);
  if (!resolved || !validBotId(botId)) return failure("malformed_response");
  const loaded = loadFromPath(resolved);
  if (loaded.state === "unavailable") return loaded;
  if (!loaded.value.has(botId)) return { state: "available", value: undefined };
  const next = new Map(loaded.value);
  next.delete(botId);
  return writeBindings(resolved, next);
}
