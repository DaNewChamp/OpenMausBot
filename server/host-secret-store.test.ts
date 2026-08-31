import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes as nodeRandomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFileEnvelopeSecretStore,
  HostSecretStoreUnavailableError,
} from "./host-secret-store.ts";

const AAD = Buffer.from("vbot-host-secrets-v1", "utf8");

function tamperEnvelope(dataDir: string, key: Buffer): void {
  const iv = Buffer.alloc(12, 4);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(["invalid"])), cipher.final()]);
  writeFileSync(
    join(dataDir, "host-secrets.bin"),
    JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    }),
    { mode: 0o600 },
  );
}

describe("createFileEnvelopeSecretStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-host-secrets-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty only when no envelope exists", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    expect(store.read()).toEqual({ status: "empty", values: {} });
  });

  it("requires an explicit absolute data directory", () => {
    expect(() => createFileEnvelopeSecretStore()).toThrow();
    expect(() => createFileEnvelopeSecretStore({ dataDir: "relative-data" })).toThrow();
  });

  it("encrypts values and never writes their plaintext", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    store.set("controlPlaneAccountToken", "account-token-value-1234567890");
    const bytes = readFileSync(join(dataDir, "host-secrets.bin"));
    expect(bytes.includes(Buffer.from("account-token-value-1234567890"))).toBe(false);
    expect(store.read()).toEqual({
      status: "ok",
      values: { controlPlaneAccountToken: "account-token-value-1234567890" },
    });
  });

  it("uses mode 0600 for key and envelope", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    store.set("x", "12345678901234567890");
    expect(statSync(join(dataDir, "host-secret.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "host-secrets.bin")).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite a corrupt existing envelope", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    writeFileSync(join(dataDir, "host-secrets.bin"), "corrupt", { mode: 0o600 });
    expect(store.read().status).toBe("unavailable");
    expect(() => store.set("replacement", "12345678901234567890")).toThrow(
      HostSecretStoreUnavailableError,
    );
    expect(readFileSync(join(dataDir, "host-secrets.bin"), "utf8")).toBe("corrupt");
  });

  it("returns unavailable when authenticated decryption fails with the wrong key", () => {
    const key = Buffer.alloc(32, 8);
    const store = createFileEnvelopeSecretStore({ dataDir, randomBytes: (size) => (size === 32 ? key : Buffer.alloc(size, 9)) });
    store.set("x", "12345678901234567890");
    writeFileSync(join(dataDir, "host-secret.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    const snapshot = store.read();
    expect(snapshot.status).toBe("unavailable");
    if (snapshot.status === "unavailable") expect(snapshot.error).not.toContain("12345678901234567890");
  });

  it("deletes the envelope when the last value is deleted", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    store.set("x", "12345678901234567890");
    store.delete("x");
    expect(existsSync(join(dataDir, "host-secrets.bin"))).toBe(false);
    expect(store.read()).toEqual({ status: "empty", values: {} });
  });

  it("validates key names and UTF-8 value byte bounds", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    expect(() => store.set("1bad", "x")).toThrow();
    expect(() => store.set("a".repeat(129), "x")).toThrow();
    expect(() => store.set("good-name_1.2", "")).toThrow();
    expect(() => store.set("good", "é".repeat(16384))).not.toThrow();
    expect(() => store.set("too-large", "é".repeat(16385))).toThrow();
    expect(() => store.set("max", "a".repeat(32768))).not.toThrow();
  });

  it("returns immutable maps", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    store.set("x", "12345678901234567890");
    const snapshot = store.read();
    expect(Object.isFrozen(snapshot.values)).toBe(true);
    if (snapshot.status === "ok") {
      expect(() => {
        (snapshot.values as Record<string, string>).x = "changed";
      }).toThrow();
    }
    expect(store.read()).toEqual({ status: "ok", values: { x: "12345678901234567890" } });
  });

  it("does not replace an existing key when another writer races key creation", () => {
    const existingKey = nodeRandomBytes(32);
    writeFileSync(join(dataDir, "host-secret.key"), existingKey, { mode: 0o600 });
    const store = createFileEnvelopeSecretStore({ dataDir, randomBytes: (size) => Buffer.alloc(size, 3) });
    store.set("x", "12345678901234567890");
    expect(readFileSync(join(dataDir, "host-secret.key"))).toEqual(existingKey);
  });

  it("preserves a valid envelope when a later mutation has an unavailable key", () => {
    const key = Buffer.alloc(32, 5);
    const store = createFileEnvelopeSecretStore({ dataDir, randomBytes: (size) => (size === 32 ? key : Buffer.alloc(size, 1)) });
    store.set("x", "12345678901234567890");
    const before = readFileSync(join(dataDir, "host-secrets.bin"));
    chmodSync(join(dataDir, "host-secret.key"), 0o000);
    try {
      expect(() => store.set("replacement", "12345678901234567890")).toThrow(HostSecretStoreUnavailableError);
    } finally {
      chmodSync(join(dataDir, "host-secret.key"), 0o600);
    }
    expect(readFileSync(join(dataDir, "host-secrets.bin"))).toEqual(before);
  });

  it("rejects malformed encrypted payloads as unavailable", () => {
    const store = createFileEnvelopeSecretStore({ dataDir });
    store.set("x", "12345678901234567890");
    tamperEnvelope(dataDir, readFileSync(join(dataDir, "host-secret.key")));
    expect(store.read().status).toBe("unavailable");
  });
});
