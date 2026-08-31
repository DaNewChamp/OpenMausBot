import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HubIdentityUnavailableError,
  loadOrCreateHubIdentity,
  readHubIdentity,
} from "./hub-identity.mjs";

const directories = [];

function makeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "vbot-hub-identity-"));
  directories.push(dataDir);
  return dataDir;
}

afterEach(() => {
  // Keep cleanup deliberately small and test-local. The fixture directories
  // are disposable and never contain credentials.
  for (const dataDir of directories.splice(0)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not hide the assertion that just ran.
    }
  }
});

describe("stable hub identity", () => {
  it("creates hub.json once with mode 0600 and reuses it", () => {
    const dataDir = makeDataDir();
    const first = loadOrCreateHubIdentity({
      dataDir,
      now: () => 1_700_000_000_000,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    });
    const second = loadOrCreateHubIdentity({
      dataDir,
      now: () => 1_800_000_000_000,
      randomId: () => "22222222-2222-4222-8222-222222222222",
    });
    assert.deepEqual(second, first);
    assert.equal(statSync(join(dataDir, "hub.json")).mode & 0o777, 0o600);
  });

  it("adopts an existing opaque Electron client instance id only on first creation", () => {
    const dataDir = makeDataDir();
    const identity = loadOrCreateHubIdentity({
      dataDir,
      preferredId: "legacy-client-instance-A",
      now: () => 123,
    });
    assert.equal(identity.id, "legacy-client-instance-A");
  });

  it("adopts an existing non-UUID id with punctuation unchanged", () => {
    const dataDir = makeDataDir();
    const preferredId = "legacy/client.instance: A_01+stable";
    const identity = loadOrCreateHubIdentity({ dataDir, preferredId, now: () => 123 });
    assert.equal(identity.id, preferredId);
  });

  it("fails closed when an existing identity is malformed", () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "hub.json"), "not-json", { mode: 0o600 });
    assert.throws(
      () => loadOrCreateHubIdentity({ dataDir }),
      HubIdentityUnavailableError,
    );
    assert.equal(readFileSync(join(dataDir, "hub.json"), "utf8"), "not-json");
    assert.equal(readHubIdentity({ dataDir }).status, "unavailable");
  });

  it("refuses first creation while the legacy credential state is unknown", () => {
    const dataDir = makeDataDir();
    assert.throws(
      () => loadOrCreateHubIdentity({ dataDir, allowCreate: false }),
      HubIdentityUnavailableError,
    );
    assert.equal(existsSync(join(dataDir, "hub.json")), false);
  });

  it("reads a valid identity while creation is disabled", () => {
    const dataDir = makeDataDir();
    const first = loadOrCreateHubIdentity({ dataDir, now: () => 123, randomId: () => "persisted" });
    assert.deepEqual(loadOrCreateHubIdentity({ dataDir, allowCreate: false }), first);
    assert.deepEqual(readHubIdentity({ dataDir }), { status: "ok", identity: first });
  });

  it("reports missing without creating a directory or file", () => {
    const dataDir = join(makeDataDir(), "nested");
    assert.deepEqual(readHubIdentity({ dataDir }), { status: "missing" });
    assert.equal(existsSync(dataDir), false);
  });

  it("creates the data directory recursively with mode 0700", () => {
    const root = makeDataDir();
    const dataDir = join(root, "nested", "runtime");
    loadOrCreateHubIdentity({ dataDir, now: () => 123, randomId: () => "opaque" });
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  });

  it("never changes a persisted id when a later preferred id differs", () => {
    const dataDir = makeDataDir();
    const first = loadOrCreateHubIdentity({ dataDir, preferredId: "original", now: () => 123 });
    const second = loadOrCreateHubIdentity({ dataDir, preferredId: "replacement", now: () => 456 });
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
  });

  it("adopts a valid identity that wins the publication race", () => {
    const dataDir = makeDataDir();
    const raced = { schemaVersion: 1, id: "winner-from-concurrent-process", createdAt: 456 };
    const identity = loadOrCreateHubIdentity({
      dataDir,
      randomId: () => {
        writeFileSync(join(dataDir, "hub.json"), JSON.stringify(raced), { mode: 0o600 });
        return "loser-that-must-not-overwrite";
      },
      now: () => 123,
    });
    assert.deepEqual(identity, raced);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "hub.json"), "utf8")), raced);
  });

  it("falls back to the injected random id when preferredId is invalid", () => {
    const dataDir = makeDataDir();
    const identity = loadOrCreateHubIdentity({
      dataDir,
      preferredId: "\nnot printable",
      randomId: () => "generated-after-invalid-preference",
      now: () => 123,
    });
    assert.equal(identity.id, "generated-after-invalid-preference");
  });

  it("rejects an invalid generated id instead of persisting it", () => {
    const dataDir = makeDataDir();
    assert.throws(
      () => loadOrCreateHubIdentity({ dataDir, randomId: () => "\u0000", now: () => 123 }),
      HubIdentityUnavailableError,
    );
    assert.equal(existsSync(join(dataDir, "hub.json")), false);
  });

  it("strictly validates the schema version, keys, id, and timestamp", () => {
    const cases = [
      { schemaVersion: 2, id: "opaque", createdAt: 123 },
      { schemaVersion: 1, id: "opaque", createdAt: 123, extra: true },
      { schemaVersion: 1, id: "", createdAt: 123 },
      { schemaVersion: 1, id: "opaque", createdAt: 1.5 },
      { schemaVersion: 1, id: "opaque", createdAt: Number.MAX_SAFE_INTEGER + 1 },
      { schemaVersion: 1, id: "opaque", createdAt: -1 },
    ];
    for (const value of cases) {
      const dataDir = makeDataDir();
      writeFileSync(join(dataDir, "hub.json"), JSON.stringify(value), { mode: 0o600 });
      assert.equal(readHubIdentity({ dataDir }).status, "unavailable");
      assert.throws(() => loadOrCreateHubIdentity({ dataDir }), HubIdentityUnavailableError);
    }
  });

  it("rejects empty, overlong, and non-printable existing ids", () => {
    for (const id of ["", "x".repeat(257), "has\ttab", "has\u0000nul"]) {
      const dataDir = makeDataDir();
      writeFileSync(
        join(dataDir, "hub.json"),
        JSON.stringify({ schemaVersion: 1, id, createdAt: 123 }),
        { mode: 0o600 },
      );
      assert.equal(readHubIdentity({ dataDir }).status, "unavailable");
    }
  });

  it("returns unavailable for an invalid data directory without a fallback path", () => {
    assert.equal(readHubIdentity({ dataDir: "relative-data-dir" }).status, "unavailable");
    assert.throws(
      () => loadOrCreateHubIdentity({ dataDir: "relative-data-dir" }),
      HubIdentityUnavailableError,
    );
  });
});
