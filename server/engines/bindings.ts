import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
} from "./contracts.ts";

const DEFAULT_BINDINGS_FILE = "hermes-bindings.json";
const DEFAULT_PENDING_FILE = "hermes-pending.json";
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_PROFILE_LENGTH = 64;
const MAX_BOT_ID_LENGTH = 256;
const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const POSIX = process.platform !== "win32";
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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

interface PendingSidecar {
  version: 1;
  profiles: string[];
}

type FileSnapshot =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "ok"; bytes: Buffer; mode: number; dev: number; ino: number };

interface LockHandle {
  path: string;
  dev: number;
  ino: number;
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

function pendingTargetPath(path?: string): string | undefined {
  if (path === undefined) return resolve(DATA_DIR, DEFAULT_PENDING_FILE);
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
  if (value.trim() !== value || PROFILE_PATTERN.test(value) === false) return false;
  if (/^session(?:[-_]|$)/i.test(value) || /^(?:root|resolved)[-_]?session/i.test(value)) return false;
  if (/^[0-9a-f]{16,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(value)) return false;
  return true;
}

function normalizeProfile(value: unknown): string | undefined {
  return validProfile(value) ? value.toLowerCase() : undefined;
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

function parsePendingSidecar(raw: unknown): Set<string> | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys.join("\u0000") !== "profiles\u0000version") return undefined;
  if (raw.version !== 1 || !Array.isArray(raw.profiles)) return undefined;

  const profiles = new Set<string>();
  for (const profile of raw.profiles) {
    const normalized = normalizeProfile(profile);
    if (!normalized || profiles.has(normalized)) return undefined;
    profiles.add(normalized);
  }
  return profiles;
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

function snapshotFile(path: string): FileSnapshot {
  const state = ensureExistingFile(path);
  if (state === "missing") return { kind: "missing" };
  if (state === "unavailable") return { kind: "unavailable" };
  try {
    const stat = lstatSync(path);
    return {
      kind: "ok",
      bytes: readFileSync(path),
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "ok" || right.kind !== "ok") return true;
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.bytes.equals(right.bytes);
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

function sleepSync(milliseconds: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

function acquireLock(path: string): LockHandle | undefined {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const lockStat = lstatSync(lockPath);
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
        try {
          rmdirSync(lockPath);
        } catch {
          // The lock was not ours to remove; leave it for the next attempt.
        }
        return undefined;
      }
      if (POSIX) chmodSync(lockPath, 0o700);
      return { path: lockPath, dev: lockStat.dev, ino: lockStat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      sleepSync(LOCK_RETRY_MS);
    }
  }
  return undefined;
}

function releaseLock(lock: LockHandle): void {
  try {
    const current = lstatSync(lock.path);
    if (current.dev === lock.dev && current.ino === lock.ino) rmdirSync(lock.path);
  } catch {
    // The lock directory should be empty and owned by this mutation. A failed
    // cleanup is intentionally not allowed to alter the published sidecar.
  }
}

function restoreSnapshot(path: string, previous: FileSnapshot): void {
  try {
    if (previous.kind === "missing") {
      const current = snapshotFile(path);
      if (current.kind === "ok") unlinkSync(path);
      return;
    }
    if (previous.kind === "ok") {
      writeFileAtomic(path, previous.bytes.toString("utf8"), { mode: previous.mode });
    }
  } catch {
    // The original atomic writer leaves a failed rename untouched. Restoration
    // is only needed for injected post-publication failures.
  }
}

function writeBindings(
  path: string,
  bindings: ReadonlyMap<string, HermesBotBinding>,
  expected: FileSnapshot,
): BindingStoreResult<void> {
  if (!ensureParent(dirname(path), true)) return failure("state_unavailable");
  const existing = snapshotFile(path);
  if (existing.kind === "unavailable" || !sameSnapshot(existing, expected)) return failure("state_unavailable");

  const diskBindings: Record<string, HermesBotBinding> = Object.create(null) as Record<string, HermesBotBinding>;
  for (const [botId, binding] of [...bindings.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
    diskBindings[botId] = canonicalBinding(binding);
  }
  const sidecar: BindingSidecar = { version: 1, bindings: diskBindings };
  const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
  try {
    writeFileAtomic(path, serialized, { mode: 0o600 });
    const published = snapshotFile(path);
    if (
      published.kind !== "ok" ||
      (POSIX && published.mode !== 0o600) ||
      published.bytes.toString("utf8") !== serialized
    ) {
      restoreSnapshot(path, existing);
      return failure("state_unavailable");
    }
  } catch {
    restoreSnapshot(path, existing);
    return failure("state_unavailable");
  }
  return { state: "available", value: undefined };
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function mutateBindings<T>(path: string, mutate: (current: ReadonlyMap<string, HermesBotBinding>, snapshot: FileSnapshot) => BindingStoreResult<T>): BindingStoreResult<T> {
  if (!ensureParent(dirname(path), true)) return failure("state_unavailable");
  const lock = acquireLock(path);
  if (!lock) return failure("state_unavailable");
  try {
    const loaded = loadFromPath(path);
    if (loaded.state === "unavailable") return loaded as BindingStoreResult<T>;
    const snapshot = snapshotFile(path);
    if (snapshot.kind === "unavailable") return failure("state_unavailable");
    return mutate(loaded.value, snapshot);
  } finally {
    releaseLock(lock);
  }
}

function loadPendingFromPath(path: string): BindingStoreResult<ReadonlySet<string>> {
  const parent = dirname(path);
  if (!ensureParent(parent, false)) {
    try {
      if (lstatSync(parent).isDirectory()) return failure("state_unavailable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failure("state_unavailable");
      return { state: "available", value: new Set() };
    }
    return failure("state_unavailable");
  }

  const state = ensureExistingFile(path);
  if (state === "missing") return { state: "available", value: new Set() };
  if (state !== "ok") return failure("state_unavailable");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return failure("malformed_response");
  }
  const profiles = parsePendingSidecar(parsed);
  return profiles ? { state: "available", value: profiles } : failure("malformed_response");
}

function writePending(
  path: string,
  profiles: ReadonlySet<string>,
  expected: FileSnapshot,
): BindingStoreResult<void> {
  if (!ensureParent(dirname(path), true)) return failure("state_unavailable");
  const existing = snapshotFile(path);
  if (existing.kind === "unavailable" || !sameSnapshot(existing, expected)) return failure("state_unavailable");

  const serializedProfiles = [...profiles].sort(compareCodePoints);
  const sidecar: PendingSidecar = { version: 1, profiles: serializedProfiles };
  const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
  try {
    writeFileAtomic(path, serialized, { mode: 0o600 });
    const published = snapshotFile(path);
    if (
      published.kind !== "ok" ||
      (POSIX && published.mode !== 0o600) ||
      published.bytes.toString("utf8") !== serialized
    ) {
      restoreSnapshot(path, existing);
      return failure("state_unavailable");
    }
  } catch {
    restoreSnapshot(path, existing);
    return failure("state_unavailable");
  }
  return { state: "available", value: undefined };
}

function mutatePending<T>(path: string, mutate: (current: ReadonlySet<string>, snapshot: FileSnapshot) => BindingStoreResult<T>): BindingStoreResult<T> {
  if (!ensureParent(dirname(path), true)) return failure("state_unavailable");
  const lock = acquireLock(path);
  if (!lock) return failure("state_unavailable");
  try {
    const loaded = loadPendingFromPath(path);
    if (loaded.state === "unavailable") return loaded as BindingStoreResult<T>;
    const snapshot = snapshotFile(path);
    if (snapshot.kind === "unavailable") return failure("state_unavailable");
    return mutate(loaded.value, snapshot);
  } finally {
    releaseLock(lock);
  }
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
  return mutateBindings(resolved, (current, snapshot) => {
    const next = new Map(current);
    next.set(botId, canonicalBinding(binding));
    return writeBindings(resolved, next, snapshot);
  });
}

export function removeHermesBinding(botId: string, path?: string): BindingStoreResult<void> {
  const resolved = targetPath(path);
  if (!resolved || !validBotId(botId)) return failure("malformed_response");
  return mutateBindings(resolved, (current, snapshot) => {
    if (!current.has(botId)) return { state: "available", value: undefined };
    const next = new Map(current);
    next.delete(botId);
    return writeBindings(resolved, next, snapshot);
  });
}

/** Load adapter-owned canonical-creation markers. Markers contain only safe
 * profile slugs; a durable/session/runtime id is deliberately never stored. */
export function loadHermesPendingProfiles(path?: string): BindingStoreResult<ReadonlySet<string>> {
  const resolved = pendingTargetPath(path);
  return resolved ? loadPendingFromPath(resolved) : failure("state_unavailable");
}

export function markHermesPendingProfile(profile: string, path?: string): BindingStoreResult<boolean> {
  const resolved = pendingTargetPath(path);
  const normalized = normalizeProfile(profile);
  if (!resolved || !normalized) return failure("malformed_response");
  return mutatePending(resolved, (current, snapshot) => {
    if (current.has(normalized)) return { state: "available", value: false };
    const next = new Set(current);
    next.add(normalized);
    const written = writePending(resolved, next, snapshot);
    return written.state === "available" ? { state: "available", value: true } : written;
  });
}

export function clearHermesPendingProfile(profile: string, path?: string): BindingStoreResult<void> {
  const resolved = pendingTargetPath(path);
  const normalized = normalizeProfile(profile);
  if (!resolved || !normalized) return failure("malformed_response");
  return mutatePending(resolved, (current, snapshot) => {
    if (!current.has(normalized)) return { state: "available", value: undefined };
    const next = new Set(current);
    next.delete(normalized);
    if (next.size === 0 && snapshot.kind === "ok") {
      try {
        unlinkSync(resolved);
        return { state: "available", value: undefined };
      } catch {
        return failure("state_unavailable");
      }
    }
    return writePending(resolved, next, snapshot);
  });
}
