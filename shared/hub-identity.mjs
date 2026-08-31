import {
  closeSync,
  chmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

const HUB_FILENAME = "hub.json";
const PUBLICATION_LOCK_FILENAME = `.${HUB_FILENAME}.lock`;
const MAX_ID_LENGTH = 256;
const PUBLICATION_LOCK_ATTEMPTS = 100;
const PUBLICATION_LOCK_WAIT_MS = 5;
const publicationWaitCell = new Int32Array(new SharedArrayBuffer(4));
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class HubIdentityUnavailableError extends Error {
  constructor(message = "Hub identity is unavailable") {
    super(message);
    this.name = "HubIdentityUnavailableError";
  }
}

function unavailable(message) {
  return { status: "unavailable", error: message };
}

function validDataDir(dataDir) {
  return (
    Object.prototype.toString.call(dataDir) === "[object String]" &&
    String(dataDir) === dataDir &&
    dataDir.length > 0 &&
    isAbsolute(dataDir)
  );
}

/** IDs are intentionally opaque. Existing clients used UUIDs, but punctuation
 * and other printable characters are valid and must be retained byte-for-byte. */
function isValidOpaqueId(value) {
  return (
    Object.prototype.toString.call(value) === "[object String]" &&
    String(value) === value &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\p{Cc}\p{Cs}\p{Cf}]/u.test(value)
  );
}

function isValidCreatedAt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseIdentity(value) {
  if (Object.prototype.toString.call(value) !== "[object Object]" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("id") ||
    !keys.includes("createdAt")
  ) {
    return null;
  }
  if (value.schemaVersion !== 1 || !isValidOpaqueId(value.id) || !isValidCreatedAt(value.createdAt)) {
    return null;
  }
  return Object.freeze({ schemaVersion: 1, id: value.id, createdAt: value.createdAt });
}

function hubPath(dataDir) {
  return join(dataDir, HUB_FILENAME);
}

function publicationLockPath(dataDir) {
  return join(dataDir, PUBLICATION_LOCK_FILENAME);
}

/**
 * Read-only identity lookup. Missing is distinct from unavailable: callers
 * may create only after they have established that legacy credential state is
 * readable. No directory or fallback home-directory path is inferred here.
 */
export function readHubIdentity(options = {}) {
  const { dataDir } = options ?? {};
  if (!validDataDir(dataDir)) return unavailable("Hub data directory is invalid");

  let bytes;
  try {
    bytes = readFileSync(hubPath(dataDir));
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return unavailable("Hub identity could not be read");
  }

  let text;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return unavailable("Hub identity is malformed");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable("Hub identity is malformed");
  }
  const identity = parseIdentity(parsed);
  return identity ? { status: "ok", identity } : unavailable("Hub identity is malformed");
}

function throwUnavailable(message) {
  throw new HubIdentityUnavailableError(message);
}

function ensureDataDir(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored when the directory already exists. The runtime
    // directory contains credentials, so enforce the private mode as well.
    chmodSync(dataDir, 0o700);
  } catch {
    throwUnavailable("Hub data directory could not be prepared");
  }
}

function writeDurableTemp(tempPath, serialized) {
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    const bytes = Buffer.from(serialized, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tempPath, 0o600);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the durable-write error below.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may not have been created.
    }
    throwUnavailable("Hub identity could not be written");
  }
}

function temporaryPath(dataDir) {
  return join(dataDir, `.${HUB_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
}

/**
 * Wait for another publisher to finish or acquire the portable sidecar lock.
 * All writers in this module serialize the check-and-rename sequence, so the
 * rename never replaces a valid identity created by a concurrent writer. A
 * stale lock fails closed rather than being removed speculatively.
 */
function acquirePublicationLock(dataDir) {
  const lockPath = publicationLockPath(dataDir);
  for (let attempt = 0; attempt < PUBLICATION_LOCK_ATTEMPTS; attempt += 1) {
    const current = readHubIdentity({ dataDir });
    if (current.status === "ok") return { identity: current.identity };
    if (current.status === "unavailable") throwUnavailable(current.error);

    try {
      return { fd: openSync(lockPath, "wx", 0o600) };
    } catch (error) {
      if (error?.code !== "EEXIST") throwUnavailable("Hub identity publication could not be locked");
      if (attempt + 1 < PUBLICATION_LOCK_ATTEMPTS) {
        Atomics.wait(publicationWaitCell, 0, 0, PUBLICATION_LOCK_WAIT_MS);
      }
    }
  }
  throwUnavailable("Hub identity publication raced with another writer");
}

function releasePublicationLock(dataDir, fd) {
  try {
    closeSync(fd);
  } catch {
    // A closed descriptor is still safe to clean up below.
  }
  try {
    unlinkSync(publicationLockPath(dataDir));
  } catch {
    // A stale lock is fail-closed for future creation; reads remain available.
  }
}

function publishIdentity(dataDir, identity) {
  const acquired = acquirePublicationLock(dataDir);
  if (acquired.identity) return acquired.identity;

  const filePath = hubPath(dataDir);
  const tempPath = temporaryPath(dataDir);
  try {
    // Recheck after acquiring the lock in case a non-cooperating writer won
    // between acquirePublicationLock's final read and lock creation.
    const beforeWrite = readHubIdentity({ dataDir });
    if (beforeWrite.status === "ok") return beforeWrite.identity;
    if (beforeWrite.status === "unavailable") throwUnavailable(beforeWrite.error);

    writeDurableTemp(tempPath, `${JSON.stringify(identity)}\n`);

    // Keep no-overwrite semantics even if an external writer does not use our
    // sidecar lock but appears before the atomic rename.
    const beforeRename = readHubIdentity({ dataDir });
    if (beforeRename.status === "ok") return beforeRename.identity;
    if (beforeRename.status === "unavailable") throwUnavailable(beforeRename.error);

    try {
      renameSync(tempPath, filePath);
    } catch {
      const raced = readHubIdentity({ dataDir });
      if (raced.status === "ok") return raced.identity;
      if (raced.status === "unavailable") throwUnavailable(raced.error);
      throwUnavailable("Hub identity could not be published");
    }

    const persisted = readHubIdentity({ dataDir });
    if (persisted.status === "ok") return persisted.identity;
    if (persisted.status === "unavailable") throwUnavailable(persisted.error);
    throwUnavailable("Hub identity disappeared after publication");
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp path is absent after rename or a failed durable write.
    }
    releasePublicationLock(dataDir, acquired.fd);
  }
}

/**
 * Return the persisted identity or create it once in the supplied canonical
 * runtime data directory. `preferredId` is used only for first creation; an
 * invalid preference is ignored in favor of the injected/default random ID.
 */
export function loadOrCreateHubIdentity(options = {}) {
  const {
    dataDir,
    preferredId,
    allowCreate = true,
    now = () => Date.now(),
    randomId = randomUUID,
  } = options ?? {};
  if (!validDataDir(dataDir)) throwUnavailable("Hub data directory is invalid");

  const existing = readHubIdentity({ dataDir });
  if (existing.status === "ok") return existing.identity;
  if (existing.status === "unavailable") throwUnavailable(existing.error);
  if (allowCreate === false) throwUnavailable("Hub identity is unavailable until credential state is known");

  ensureDataDir(dataDir);

  // Recheck after preparing the directory: another process may have created
  // the identity while this process was making the directory private.
  const afterPrepare = readHubIdentity({ dataDir });
  if (afterPrepare.status === "ok") return afterPrepare.identity;
  if (afterPrepare.status === "unavailable") throwUnavailable(afterPrepare.error);

  let id = preferredId;
  if (!isValidOpaqueId(id)) {
    try {
      id = randomId();
    } catch {
      throwUnavailable("Hub identity could not be generated");
    }
  }
  if (!isValidOpaqueId(id)) throwUnavailable("Hub identity generator returned an invalid ID");

  let createdAt;
  try {
    createdAt = now();
  } catch {
    throwUnavailable("Hub identity timestamp could not be generated");
  }
  if (!isValidCreatedAt(createdAt)) throwUnavailable("Hub identity timestamp is invalid");

  return publishIdentity(dataDir, Object.freeze({ schemaVersion: 1, id, createdAt }));
}
