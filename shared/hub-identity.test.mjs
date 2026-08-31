import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  HubIdentityUnavailableError,
  ensurePrivateDataDir,
  inspectPrivateDataDir,
  loadOrCreateHubIdentity,
  readHubIdentity,
} from "./hub-identity.mjs";

const directories = [];

function makeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "vbot-hub-identity-"));
  directories.push(dataDir);
  return dataDir;
}

function runConcurrentCreator(moduleUrl, dataDir, preferredId) {
  const script = `import { loadOrCreateHubIdentity } from ${JSON.stringify(moduleUrl)};
const identity = loadOrCreateHubIdentity({
  dataDir: process.env.HUB_DATA_DIR,
  preferredId: process.env.HUB_PREFERRED_ID,
  now: () => 123,
});
process.stdout.write(JSON.stringify(identity));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HUB_DATA_DIR: dataDir, HUB_PREFERRED_ID: preferredId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`concurrent creator exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`concurrent creator returned invalid JSON: ${error.message}`));
      }
    });
  });
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

  it("fails closed on malformed UTF-8 without reminting or changing bytes", () => {
    const dataDir = makeDataDir();
    // Replace the escaped sequence with an invalid UTF-8 byte sequence inside
    // an otherwise valid JSON object. Replacement decoding would incorrectly
    // accept this as an opaque ID.
    const invalidBytes = Buffer.from(
      '{"schemaVersion":1,"id":"legacy',
      "utf8",
    );
    const suffix = Buffer.from('","createdAt":123}', "utf8");
    const bytes = Buffer.concat([invalidBytes, Buffer.from([0xc3, 0x28]), suffix]);
    writeFileSync(join(dataDir, "hub.json"), bytes, { mode: 0o600 });
    const before = readFileSync(join(dataDir, "hub.json"));

    assert.equal(readHubIdentity({ dataDir }).status, "unavailable");
    assert.throws(() => loadOrCreateHubIdentity({ dataDir }), HubIdentityUnavailableError);
    assert.deepEqual(readFileSync(join(dataDir, "hub.json")), before);
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

  it("adopts a valid identity created after the final publication check", () => {
    const dataDir = makeDataDir();
    const raced = { schemaVersion: 1, id: "winner-after-final-check", createdAt: 789 };
    const identity = loadOrCreateHubIdentity({
      dataDir,
      preferredId: "loser-that-must-not-overwrite",
      now: () => 123,
      beforePublish: () => {
        writeFileSync(join(dataDir, "hub.json"), JSON.stringify(raced), { mode: 0o600 });
      },
    });
    assert.deepEqual(identity, raced);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "hub.json"), "utf8")), raced);
  });

  it("serializes concurrent creators and adopts one identity without replacement", async () => {
    const dataDir = makeDataDir();
    const moduleUrl = new URL("./hub-identity.mjs", import.meta.url).href;
    const [first, second] = await Promise.all([
      runConcurrentCreator(moduleUrl, dataDir, "concurrent-first"),
      runConcurrentCreator(moduleUrl, dataDir, "concurrent-second"),
    ]);

    assert.deepEqual(second, first);
    assert.deepEqual(readHubIdentity({ dataDir }), { status: "ok", identity: first });
    assert.equal(existsSync(join(dataDir, ".hub.json.lock")), false);
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

  it("releases its lock when temporary-path generation throws", () => {
    const dataDir = makeDataDir();
    assert.throws(
      () =>
        loadOrCreateHubIdentity({
          dataDir,
          preferredId: "stable-id",
          now: () => 123,
          tempPathFactory: () => {
            throw new Error("injected temporary path failure");
          },
        }),
      HubIdentityUnavailableError,
    );
    assert.equal(existsSync(join(dataDir, ".hub.json.lock")), false);
    assert.deepEqual(
      loadOrCreateHubIdentity({ dataDir, preferredId: "recovered", now: () => 456 }),
      { schemaVersion: 1, id: "recovered", createdAt: 456 },
    );
  });

  it("releases its lock when UUID-based temporary-path generation throws", () => {
    const dataDir = makeDataDir();
    assert.throws(
      () =>
        loadOrCreateHubIdentity({
          dataDir,
          preferredId: "stable-id",
          now: () => 123,
          randomUUID: () => {
            throw new Error("injected UUID failure");
          },
        }),
      HubIdentityUnavailableError,
    );
    assert.equal(existsSync(join(dataDir, ".hub.json.lock")), false);
  });

  it("does not remove a replacement lock owned by another publisher", () => {
    const dataDir = makeDataDir();
    const lockPath = join(dataDir, ".hub.json.lock");
    assert.throws(
      () =>
        loadOrCreateHubIdentity({
          dataDir,
          preferredId: "stable-id",
          now: () => 123,
          beforePublish: () => {
            unlinkSync(lockPath);
            writeFileSync(lockPath, "replacement-owner", { mode: 0o600, flag: "wx" });
            throw new Error("stop before publication");
          },
        }),
      HubIdentityUnavailableError,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "replacement-owner");
    unlinkSync(lockPath);
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

  it("repairs existing directory modes before identity creation", () => {
    const dataDir = makeDataDir();
    chmodSync(dataDir, 0o755);
    assert.equal(inspectPrivateDataDir(dataDir), "needs-repair");
    ensurePrivateDataDir(dataDir);
    assert.equal(inspectPrivateDataDir(dataDir), "ok");
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  });

  it("rejects a symlink or regular file as the runtime directory", () => {
    const root = makeDataDir();
    const target = join(root, "target");
    const link = join(root, "link");
    const file = join(root, "file");
    // The target itself is deliberately absent: a dangling symlink must not
    // be followed or replaced by recursive directory creation.
    symlinkSync(target, link);
    writeFileSync(file, "not a directory");
    assert.equal(inspectPrivateDataDir(link), "unavailable");
    assert.equal(inspectPrivateDataDir(`${link}/`), "unavailable");
    assert.throws(() => ensurePrivateDataDir(link), HubIdentityUnavailableError);
    assert.throws(() => ensurePrivateDataDir(`${link}/`), HubIdentityUnavailableError);
    assert.equal(inspectPrivateDataDir(file), "unavailable");
    assert.throws(() => ensurePrivateDataDir(file), HubIdentityUnavailableError);
  });
});
