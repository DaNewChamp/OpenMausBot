import {
  closeSync,
  chmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

const HUB_FILENAME = "hub.json";
const MAX_ID_LENGTH = 256;

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
    bytes = readFileSync(hubPath(dataDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return unavailable("Hub identity could not be read");
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes);
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
 * Publish without replacing a concurrently-created identity. A hard link is
 * the filesystem's atomic no-replace operation; the temporary inode was
 * already fsynced and has mode 0600. If another process wins, its final file
 * is reread and adopted unchanged.
 */
function publishIdentity(dataDir, identity) {
  const filePath = hubPath(dataDir);
  const tempPath = temporaryPath(dataDir);
  writeDurableTemp(tempPath, `${JSON.stringify(identity)}\n`);

  try {
    linkSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The link succeeded and only temporary cleanup failed, or the file
      // was already removed after a race.
    }
    if (error?.code !== "EEXIST") throwUnavailable("Hub identity could not be published");

    const raced = readHubIdentity({ dataDir });
    if (raced.status === "ok") return raced.identity;
    if (raced.status === "unavailable") throwUnavailable(raced.error);
    throwUnavailable("Hub identity publication raced with another writer");
  }

  try {
    unlinkSync(tempPath);
  } catch {
    // The final hard link is already durable; an orphaned temporary inode is
    // harmless and will not affect subsequent identity reads.
  }

  const persisted = readHubIdentity({ dataDir });
  if (persisted.status === "ok") return persisted.identity;
  if (persisted.status === "unavailable") throwUnavailable(persisted.error);
  throwUnavailable("Hub identity disappeared after publication");
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
