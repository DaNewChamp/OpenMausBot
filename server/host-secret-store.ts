import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

const KEY_FILE = "host-secret.key";
const ENVELOPE_FILE = "host-secrets.bin";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_VALUE_BYTES = 32_768;
const AAD = Buffer.from("vbot-host-secrets-v1", "utf8");
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const FILE_MODE = 0o600;

type RandomBytes = (size: number) => Buffer;
type SecretValues = Record<string, string>;

interface SecretEnvelopeV1 {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export type HostSecretSnapshot =
  | { status: "empty"; values: Record<string, string> }
  | { status: "ok"; values: Record<string, string> }
  | { status: "unavailable"; values: Record<string, never>; error: string };

export class HostSecretStoreUnavailableError extends Error {
  constructor(message = "host secret store unavailable") {
    super(message);
    this.name = "HostSecretStoreUnavailableError";
  }
}

export interface HostSecretStore {
  read(): HostSecretSnapshot;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/**
 * Stores headless host credentials in an AES-256-GCM envelope under the
 * caller-provided runtime directory. This protects archives and accidental
 * plaintext exposure, but cannot protect secrets from a host compromised as
 * root (root can read both the key and the encrypted envelope).
 */
export function createFileEnvelopeSecretStore(options?: {
  dataDir: string;
  randomBytes?: RandomBytes;
}): HostSecretStore {
  if (!options || typeof options.dataDir !== "string" || options.dataDir.length === 0 || !isAbsolute(options.dataDir)) {
    throw new TypeError("dataDir must be an explicit absolute path");
  }

  const dataDir = resolve(options.dataDir);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new TypeError("dataDir is unavailable");
  }

  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const keyPath = join(dataDir, KEY_FILE);
  const envelopePath = join(dataDir, ENVELOPE_FILE);

  function read(): HostSecretSnapshot {
    try {
      const envelope = readEnvelope();
      if (envelope === null) return emptySnapshot();
      const key = readKey(false);
      return okSnapshot(decryptValues(key, envelope));
    } catch {
      return unavailableSnapshot();
    }
  }

  function set(name: string, value: string): void {
    validateName(name);
    validateValue(value);

    const current = readMutationState();
    const values: SecretValues = { ...current.values };
    values[name] = value;

    try {
      const key = current.key ?? readKey(true);
      writeEnvelope(key, values);
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  function remove(name: string): void {
    validateName(name);

    const current = readMutationState();
    if (current.envelope === null || !Object.hasOwn(current.values, name)) return;

    const values: SecretValues = { ...current.values };
    delete values[name];

    try {
      if (Object.keys(values).length === 0) {
        unlinkSync(envelopePath);
      } else {
        const key = current.key;
        if (key === null) throw unavailableError();
        writeEnvelope(key, values);
      }
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  function readMutationState(): { envelope: SecretEnvelopeV1 | null; key: Buffer | null; values: SecretValues } {
    try {
      const envelope = readEnvelope();
      if (envelope === null) return { envelope: null, key: null, values: {} };
      const key = readKey(false);
      return { envelope, key, values: decryptValues(key, envelope) };
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  function readEnvelope(): SecretEnvelopeV1 | null {
    let raw: string;
    try {
      raw = readFileSync(envelopePath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw unavailableError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw unavailableError();
    }
    return validateEnvelope(parsed);
  }

  function readKey(createIfMissing: boolean): Buffer {
    try {
      const key = readFileSync(keyPath);
      if (key.length !== KEY_BYTES) throw unavailableError();
      return Buffer.from(key);
    } catch (error) {
      if (!createIfMissing || !hasCode(error, "ENOENT")) throw asUnavailable(error);
      return createKeyExclusive();
    }
  }

  function createKeyExclusive(): Buffer {
    const key = randomBytesExact(KEY_BYTES);
    const tempPath = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, FILE_MODE);
      writeFileSync(fd, key);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;

      try {
        // A hard link installs the fully-written inode without replacing a
        // key another writer may have created concurrently.
        linkSync(tempPath, keyPath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        unlinkSync(tempPath);
        return readKey(false);
      }
      unlinkSync(tempPath);
      return key;
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best-effort cleanup
        }
      }
      try {
        unlinkSync(tempPath);
      } catch {
        // best-effort cleanup
      }
      throw asUnavailable(error);
    }
  }

  function writeEnvelope(key: Buffer, values: SecretValues): void {
    const iv = randomBytesExact(IV_BYTES);
    const plaintext = Buffer.from(canonicalValues(values), "utf8");
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: SecretEnvelopeV1 = {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        authTag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      };
      writeFileAtomic(envelopePath, JSON.stringify(envelope), { mode: FILE_MODE });
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  function randomBytesExact(size: number): Buffer {
    try {
      const bytes = randomBytes(size);
      if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw unavailableError();
      return Buffer.from(bytes);
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  function decryptValues(key: Buffer, envelope: SecretEnvelopeV1): SecretValues {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, decodeField(envelope.iv));
      decipher.setAAD(AAD);
      decipher.setAuthTag(decodeField(envelope.authTag));
      const ciphertext = decodeField(envelope.ciphertext);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const parsed: unknown = JSON.parse(plaintext);
      return validateValues(parsed);
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  function validateEnvelope(value: unknown): SecretEnvelopeV1 {
    if (!isPlainObject(value)) throw unavailableError();
    const keys = Object.keys(value).sort();
    if (keys.join("\0") !== ["algorithm", "authTag", "ciphertext", "iv", "version"].join("\0")) {
      throw unavailableError();
    }
    if (
      value.version !== 1 ||
      value.algorithm !== "aes-256-gcm" ||
      typeof value.iv !== "string" ||
      typeof value.authTag !== "string" ||
      typeof value.ciphertext !== "string"
    ) {
      throw unavailableError();
    }
    const iv = decodeField(value.iv);
    const authTag = decodeField(value.authTag);
    const ciphertext = decodeField(value.ciphertext);
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
      throw unavailableError();
    }
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: value.iv,
      authTag: value.authTag,
      ciphertext: value.ciphertext,
    };
  }

  function decodeField(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unavailableError();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== value) throw unavailableError();
    return bytes;
  }

  return { read, set, delete: remove };
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) throw new TypeError("invalid host secret name");
}

function validateValue(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new TypeError("invalid host secret value");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > MAX_VALUE_BYTES) throw new RangeError("invalid host secret value length");
}

function validateValues(value: unknown): SecretValues {
  if (!isPlainObject(value)) throw unavailableError();
  const out: SecretValues = {};
  for (const name of Object.keys(value)) {
    const entry = value[name];
    validateName(name);
    validateValue(entry);
    Object.defineProperty(out, name, { configurable: true, enumerable: true, value: entry, writable: true });
  }
  return out;
}

function canonicalValues(values: SecretValues): string {
  const sorted: SecretValues = {};
  for (const name of Object.keys(values).sort()) {
    Object.defineProperty(sorted, name, {
      configurable: true,
      enumerable: true,
      value: values[name],
      writable: true,
    });
  }
  return JSON.stringify(sorted);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function unavailableError(): HostSecretStoreUnavailableError {
  return new HostSecretStoreUnavailableError();
}

function asUnavailable(error: unknown): HostSecretStoreUnavailableError {
  if (error instanceof HostSecretStoreUnavailableError) return error;
  return unavailableError();
}

function emptySnapshot(): HostSecretSnapshot {
  return { status: "empty", values: Object.freeze({}) };
}

function okSnapshot(values: SecretValues): HostSecretSnapshot {
  return { status: "ok", values: Object.freeze({ ...values }) };
}

function unavailableSnapshot(): HostSecretSnapshot {
  return { status: "unavailable", values: Object.freeze({}) as Record<string, never>, error: "host secret store unavailable" };
}
