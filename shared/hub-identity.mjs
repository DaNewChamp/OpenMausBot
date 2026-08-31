import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

const HUB_FILENAME = "hub.json";
const { COPYFILE_EXCL } = constants;
const PUBLICATION_LOCK_FILENAME = `.${HUB_FILENAME}.lock`;
const MAX_ID_LENGTH = 256;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PUBLICATION_LOCK_ATTEMPTS = 100;
const PUBLICATION_LOCK_WAIT_MS = 5;
const publicationWaitCell = new Int32Array(new SharedArrayBuffer(4));
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
let publicationLockSequence = 0;

function isPosixPlatform(platform = process.platform) {
  return platform !== "win32";
}

function hasCurrentPosixOwner(stat, platform = process.platform) {
  return !isPosixPlatform(platform) || typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function hasPrivatePosixMetadata(stat, mode, platform = process.platform) {
  if (!isPosixPlatform(platform)) return true;
  return hasCurrentPosixOwner(stat, platform) && (stat.mode & 0o7777 & ~mode) === 0;
}

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

/**
 * Inspect the caller-provided runtime directory without creating it or
 * following a final-component symlink. A missing directory is safe to create;
 * on POSIX every existing directory must be owner-controlled with no
 * group/other permissions before identity or secret files are touched.
 */
export function inspectPrivateDataDir(dataDir, { platform = process.platform } = {}) {
  if (!validDataDir(dataDir)) return "unavailable";
  const directoryPath = resolve(dataDir);
  let directory;
  try {
    directory = lstatSync(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    return "unavailable";
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) return "unavailable";
  if (!hasCurrentPosixOwner(directory, platform)) return "unavailable";
  if (isPosixPlatform(platform) && (directory.mode & 0o7777 & ~PRIVATE_DIRECTORY_MODE) !== 0) {
    return "needs-repair";
  }
  return "ok";
}

/**
 * Prepare and revalidate the explicit runtime directory. On POSIX, existing
 * unsafe modes are narrowed to 0700 only after ownership and directory type
 * checks; symlinks, files, ownership mismatches, and races fail closed on all
 * platforms.
 */
export function ensurePrivateDataDir(dataDir, { platform = process.platform } = {}) {
  if (!validDataDir(dataDir)) throwUnavailable("Hub data directory is invalid");
  const directoryPath = resolve(dataDir);

  let before;
  try {
    before = lstatSync(directoryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throwUnavailable("Hub data directory is unavailable");
    try {
      mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      before = lstatSync(directoryPath);
    } catch {
      throwUnavailable("Hub data directory could not be prepared");
    }
  }

  if (!before.isDirectory() || before.isSymbolicLink()) {
    throwUnavailable("Hub data directory is unavailable");
  }
  if (isPosixPlatform(platform) && typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throwUnavailable("Hub data directory is unavailable");
  }

  try {
    if (isPosixPlatform(platform)) chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
    const after = lstatSync(directoryPath);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !hasPrivatePosixMetadata(after, PRIVATE_DIRECTORY_MODE, platform)
    ) {
      throwUnavailable("Hub data directory is unavailable");
    }
  } catch (error) {
    if (error instanceof HubIdentityUnavailableError) throw error;
    throwUnavailable("Hub data directory could not be prepared");
  }
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
  const { dataDir, platform = process.platform } = options ?? {};
  if (!validDataDir(dataDir)) return unavailable("Hub data directory is invalid");

  const directoryStatus = inspectPrivateDataDir(dataDir, { platform });
  if (directoryStatus === "missing") return { status: "missing" };
  if (directoryStatus !== "ok") return unavailable("Hub data directory is unavailable");

  const filePath = hubPath(dataDir);
  let initial;
  try {
    initial = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return unavailable("Hub identity could not be read");
  }

  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    !hasPrivatePosixMetadata(initial, PRIVATE_FILE_MODE, platform)
  ) {
    return unavailable("Hub identity could not be read");
  }

  let bytes;
  let fd;
  try {
    const noFollow = isPosixPlatform(platform) ? constants.O_NOFOLLOW ?? 0 : 0;
    fd = openSync(filePath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      !hasPrivatePosixMetadata(opened, PRIVATE_FILE_MODE, platform)
    ) {
      return unavailable("Hub identity could not be read");
    }
    bytes = readFileSync(fd);
    const final = lstatSync(filePath);
    if (
      !final.isFile() ||
      final.isSymbolicLink() ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      !hasPrivatePosixMetadata(final, PRIVATE_FILE_MODE, platform)
    ) {
      return unavailable("Hub identity could not be read");
    }
  } catch {
    return unavailable("Hub identity could not be read");
  } finally {
    if (fd !== undefined) closeSync(fd);
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

function writeDurableTemp(tempPath, serialized, platform) {
  let fd;
  let created = false;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    created = true;
    const bytes = Buffer.from(serialized, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    if (isPosixPlatform(platform)) chmodSync(tempPath, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the durable-write error below.
      }
    }
    if (created) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temporary file may already have been removed.
      }
    }
    throwUnavailable("Hub identity could not be written");
  }
}

function temporaryPath(dataDir, randomUuid) {
  return join(dataDir, `.${HUB_FILENAME}.${process.pid}.${randomUuid()}.tmp`);
}

/**
 * Wait for another publisher to finish or acquire the portable sidecar lock.
 * A stale lock fails closed rather than being removed speculatively. The lock
 * token and inode are retained so release cannot remove a replacement lock.
 */
function acquirePublicationLock(dataDir, platform) {
  const lockPath = publicationLockPath(dataDir);
  for (let attempt = 0; attempt < PUBLICATION_LOCK_ATTEMPTS; attempt += 1) {
    const current = readHubIdentity({ dataDir, platform });
    if (current.status === "ok") return { identity: current.identity };
    if (current.status === "unavailable") throwUnavailable(current.error);

    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        const token = `${process.pid}:${Date.now()}:${publicationLockSequence++}`;
        const bytes = Buffer.from(token, "utf8");
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
        fsyncSync(fd);
        const owner = fstatSync(fd);
        return { lock: { fd, token, dev: owner.dev, ino: owner.ino } };
      } catch {
        try {
          closeSync(fd);
        } catch {
          // Preserve the lock acquisition error below.
        }
        throwUnavailable("Hub identity publication could not be locked");
      }
    } catch (error) {
      if (error instanceof HubIdentityUnavailableError) throw error;
      if (error?.code !== "EEXIST") throwUnavailable("Hub identity publication could not be locked");
      if (attempt + 1 < PUBLICATION_LOCK_ATTEMPTS) {
        Atomics.wait(publicationWaitCell, 0, 0, PUBLICATION_LOCK_WAIT_MS);
      }
    }
  }
  throwUnavailable("Hub identity publication raced with another writer");
}

function releasePublicationLock(dataDir, lock) {
  const lockPath = publicationLockPath(dataDir);
  let owned = false;
  try {
    const current = statSync(lockPath);
    if (current.dev === lock.dev && current.ino === lock.ino) {
      const token = readFileSync(lockPath, "utf8");
      const confirmed = statSync(lockPath);
      owned = confirmed.dev === lock.dev && confirmed.ino === lock.ino && token === lock.token;
    }
  } catch {
    // A missing or replaced lock is not ours to remove.
  }
  if (owned) {
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale lock is fail-closed for future creation; reads remain available.
    }
  }
  try {
    closeSync(lock.fd);
  } catch {
    // A closed descriptor is still safe to clean up below.
  }
}

function syncPublishedFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishIdentity(dataDir, identity, { platform, tempPathFactory, beforePublish }) {
  const acquired = acquirePublicationLock(dataDir, platform);
  if (acquired.identity) return acquired.identity;

  const filePath = hubPath(dataDir);
  let tempPath;
  let tempCreated = false;
  try {
    // Recheck after acquiring the lock in case a non-cooperating writer won
    // between acquirePublicationLock's final read and lock creation.
    const beforeWrite = readHubIdentity({ dataDir, platform });
    if (beforeWrite.status === "ok") return beforeWrite.identity;
    if (beforeWrite.status === "unavailable") throwUnavailable(beforeWrite.error);

    try {
      tempPath = tempPathFactory(dataDir);
    } catch {
      throwUnavailable("Hub identity temporary path could not be generated");
    }
    if (tempPath === filePath) throwUnavailable("Hub identity temporary path is invalid");
    writeDurableTemp(tempPath, `${JSON.stringify(identity)}\n`, platform);
    tempCreated = true;

    // Keep no-overwrite semantics even if an external writer does not use our
    // sidecar lock but appears before the exclusive copy.
    const beforeRename = readHubIdentity({ dataDir, platform });
    if (beforeRename.status === "ok") return beforeRename.identity;
    if (beforeRename.status === "unavailable") throwUnavailable(beforeRename.error);

    if (beforePublish !== undefined) {
      try {
        beforePublish();
      } catch {
        throwUnavailable("Hub identity publication could not be prepared");
      }
    }

    try {
      copyFileSync(tempPath, filePath, COPYFILE_EXCL);
      if (isPosixPlatform(platform)) chmodSync(filePath, PRIVATE_FILE_MODE);
      syncPublishedFile(filePath);
    } catch (error) {
      const raced = readHubIdentity({ dataDir, platform });
      if (raced.status === "ok") return raced.identity;
      if (raced.status === "unavailable") throwUnavailable(raced.error);
      if (error?.code === "EEXIST") {
        throwUnavailable("Hub identity publication raced with another writer");
      }
      throwUnavailable("Hub identity could not be published");
    }

    const persisted = readHubIdentity({ dataDir, platform });
    if (persisted.status === "ok") return persisted.identity;
    if (persisted.status === "unavailable") throwUnavailable(persisted.error);
    throwUnavailable("Hub identity disappeared after publication");
  } finally {
    if (tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temporary file may already have been removed.
      }
    }
    releasePublicationLock(dataDir, acquired.lock);
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
    platform = process.platform,
    preferredId,
    allowCreate = true,
    now = () => Date.now(),
    randomId = cryptoRandomUUID,
    randomUUID = cryptoRandomUUID,
    tempPathFactory = (directory) => temporaryPath(directory, randomUUID),
    beforePublish,
  } = options ?? {};
  if (!validDataDir(dataDir)) throwUnavailable("Hub data directory is invalid");

  const directoryStatus = inspectPrivateDataDir(dataDir, { platform });
  if (directoryStatus === "missing" && allowCreate === false) {
    throwUnavailable("Hub identity is unavailable until credential state is known");
  }
  // On POSIX, existing unsafe modes are narrowed before reading or publishing
  // identity data; symlinks, files, ownership mismatches, and races fail
  // closed on all platforms.
  ensurePrivateDataDir(dataDir, { platform });

  const existing = readHubIdentity({ dataDir, platform });
  if (existing.status === "ok") return existing.identity;
  if (existing.status === "unavailable") throwUnavailable(existing.error);
  if (allowCreate === false) throwUnavailable("Hub identity is unavailable until credential state is known");

  // Recheck after preparing the directory: another process may have created
  // the identity while this process was making the directory private.
  const afterPrepare = readHubIdentity({ dataDir, platform });
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

  return publishIdentity(dataDir, Object.freeze({ schemaVersion: 1, id, createdAt }), {
    platform,
    tempPathFactory,
    beforePublish,
  });
}
