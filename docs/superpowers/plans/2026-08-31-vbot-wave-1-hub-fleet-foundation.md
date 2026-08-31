# V Bot Wave 1 Hub and Fleet Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every V Bot hub a stable local identity and runtime profile, add a safe headless secret store, and extend the existing account control plane with presence and read-only fleet discovery without changing companion pairing or mobile authorization. Establish one canonical data directory per runtime, one wire-platform vocabulary, and an explicit presence shutdown lifecycle before implementation begins.

**Architecture:** A stable `hub.json` identity becomes the control-plane `clientInstanceId`. Electron uses the final `app.getPath("userData")` (after the existing compatibility-path adoption) as its canonical hub data directory; headless hubs require an explicit absolute runtime data directory. Desktop hubs keep Electron `safeStorage`; headless hubs use an AES-256-GCM envelope backed by a separately stored mode-0600 host key. Installations heartbeat safe runtime metadata to the control plane, and account-authenticated callers list owned hubs through `/v1/fleet`. The data plane remains hub-to-client pairing through the existing companion.

**Tech Stack:** TypeScript, Node.js 24+, Electron ESM, Cloudflare Workers, D1 SQLite migrations, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-vbot-distributed-platform-design.md`

## Global Constraints

- Implement in `/Users/Vincent/Github/.worktrees/vbot-wave1-hub-fleet` on branch `feat/vbot-hub-fleet-foundation` based on the current `vbot-private/main`.
- Do not implement iOS account login, pairing invitations, provider connections, node v2, execution targets, production deployment, or TestFlight in this wave.
- Do not modify production Cloudflare resources, D1 databases, DNS, tunnels, Servarica, or the hosted Mac runtime.
- Existing desktop account sign-in and managed endpoint behavior must remain compatible.
- Existing installations created by older clients decode as `runtimeProfile = desktop-hub`, `capabilities = []`, and offline until their next presence update.
- Existing Electron installation identity must be adopted, not replaced.
- Existing hub, client-instance, and installation IDs are opaque stable strings. Adopt a valid non-empty legacy ID even when it is not a UUID; UUIDs are allowed only as a choice for newly minted IDs. An unreadable, malformed, or empty identity/credential record is unavailable. Never treat it as empty and never mint replacement credentials automatically.
- The legacy Electron `companionClientInstanceId` field is reconciled to the adopted `hub.json` ID before registration and remains the cleanup authority; cleanup must not skip an opaque non-UUID ID.
- Wire platform values are exactly `darwin`, `windows`, or `linux`. Map Node `process.platform === "win32"` to `windows` at the runtime boundary; no `win32` value is sent to the Worker or persisted in fleet metadata.
- Presence has explicit idempotent `stopPresence()` and `dispose()` APIs. Sign-out and app quit call them. Electron keeps its current endpoint deletion and installation revocation behavior; headless sign-out removes only the account bearer and retains hub/installation identity and credential.
- `shared/runtime-profile.ts` is the source of truth for the runtime-profile vocabulary. The Worker derives its validator from that list and a parity test fails on drift. Node Only and Hub plus Node are deployment compositions deferred to Wave 4, not Wave 1 runtime roles.
- The shared fleet decoder is strict. CLI redaction tests are defense-in-depth fixtures for dependency-injected or legacy objects and must never weaken strict decoding.
- Local smoke uses a test-only in-memory OTP/mail fixture and an explicit loopback control-plane URL such as `http://127.0.0.1:8787`; no production OTP route, static code, or auth bypass is permitted.
- Account bearers are accepted only by account/fleet routes. Installation credentials are accepted only by self/presence/endpoint routes. Neither is accepted by companion.
- No secret value may be written to `config.json`, fleet metadata, logs, argv, test snapshots, or error messages.

---

## File map

### New shared files

- `shared/runtime-profile.ts`: runtime profile vocabulary and validation.
- `shared/runtime-profile.test.ts`: fixed-vocabulary and legacy-default tests.
- `shared/runtime-platform.ts`: canonical wire-platform vocabulary and the `win32 -> windows` runtime-boundary mapping.
- `shared/runtime-platform.test.ts`: platform mapping and unknown-platform rejection tests.
- `shared/hub-identity.mjs`: Electron-compatible stable identity lifecycle.
- `shared/hub-identity.test.mjs`: creation, adoption, permissions, and corruption tests.
- `shared/control-plane-client.mjs`: environment-neutral control-plane client extracted from Electron.
- `shared/control-plane-client.test.mjs`: fleet and presence client tests.

### New server files

- `server/host-secret-store.ts`: headless encrypted secret envelope.
- `server/host-secret-store.test.ts`: encryption, update, corruption, and write-permission tests.

### New control-plane files

- `cloudflare/control-plane/migrations/0006_fleet_presence.sql`: safe installation presence columns.
- `cloudflare/control-plane/src/fleet.ts`: presence update and account fleet listing.
- `cloudflare/control-plane/test/fleet.test.ts`: ownership, auth separation, validation, and online-state tests.
- `cloudflare/control-plane/test/runtime-profile-parity.test.ts`: native/Worker runtime-profile source-of-truth parity tests (or include these assertions in `fleet.test.ts`).

### New headless runtime files

- `runtime/src/hub-account.ts`: account registration and presence orchestration.
- `runtime/src/hub-account.test.ts`: stable registration and failure behavior.
- `runtime/src/cli.ts`: Wave 1 `vbotctl` commands.
- `runtime/src/cli.test.ts`: parsing, stdin handling, and secret-redaction tests.
- `tsconfig.runtime.build.json`: runtime build target that includes required shared ESM modules.

### Existing files to modify

- `electron/control-plane-client.mjs`: compatibility re-export.
- `electron/control-plane-client.test.mjs`: preserve existing behavior and cover the wrapper.
- `electron/companion-account-service.mjs`: attach runtime profile and presence heartbeat.
- `electron/companion-account-service.test.mjs`: stable identity and heartbeat tests.
- `electron/main.mjs`: load or adopt the stable hub identity before account provisioning.
- `cloudflare/control-plane/src/installations.ts`: return new safe installation fields with legacy defaults.
- `cloudflare/control-plane/src/index.ts`: route `/v1/fleet` and `/v1/installations/self/presence`.
- `cloudflare/control-plane/README.md`: document fleet metadata and trust separation.
- `package.json`: add runtime build, test, and CLI scripts.
- `README.md`: document stable hub identity and headless registration commands.
- `docs/cloud-vps-hosting.md`: add local-development registration and presence verification.
- Existing backup scripts/tests only when the audit in Task 8 proves that their include/exclude rules omit canonical `hub.json` or encrypted secret-store files; no production backup or deployment is run in this wave.

---

### Task 1: Define runtime profiles and the wire-platform boundary

**Files:**
- Create: `shared/runtime-profile.ts`
- Create: `shared/runtime-profile.test.ts`
- Create: `shared/runtime-platform.ts`
- Create: `shared/runtime-platform.test.ts`

**Interfaces:**
- Produces: `RuntimeProfile`, `RUNTIME_PROFILES`, `isRuntimeProfile()`, `normalizeRuntimeProfile()`.
- Produces: `WirePlatform`, `WIRE_PLATFORMS`, `isWirePlatform()`, and `normalizeWirePlatform()`; the latter maps Node's `win32` to wire value `windows`.
- Consumed by: control-plane fleet validation, Electron presence, and headless runtime. `shared/runtime-profile.ts` is the only maintained runtime-profile list; the Worker imports it (or a generated re-export) rather than declaring a second list.

- [ ] **Step 1: Write the failing profile tests**

```ts
import { describe, expect, it } from "vitest";
import {
  isRuntimeProfile,
  normalizeRuntimeProfile,
  RUNTIME_PROFILES,
} from "./runtime-profile.ts";

describe("runtime profiles", () => {
  it("keeps the fixed public vocabulary", () => {
    expect(RUNTIME_PROFILES).toEqual([
      "desktop-hub",
      "headless-hub",
      "desktop-client",
    ]);
  });

  it("defaults legacy missing values to desktop-hub", () => {
    expect(normalizeRuntimeProfile(undefined)).toBe("desktop-hub");
    expect(normalizeRuntimeProfile(null)).toBe("desktop-hub");
  });

  it("rejects unknown values instead of publishing them", () => {
    expect(isRuntimeProfile("node-only")).toBe(false);
    expect(() => normalizeRuntimeProfile("node-only")).toThrow(
      "invalid runtime profile",
    );
  });
});
```

Add platform-boundary tests:

```ts
import { describe, expect, it } from "vitest";
import { WIRE_PLATFORMS, normalizeWirePlatform } from "./runtime-platform.ts";

describe("wire platforms", () => {
  it("keeps the canonical transport vocabulary", () => {
    expect(WIRE_PLATFORMS).toEqual(["darwin", "windows", "linux"]);
  });

  it("maps Node win32 to windows at the runtime boundary", () => {
    expect(normalizeWirePlatform("win32")).toBe("windows");
    expect(normalizeWirePlatform("windows")).toBe("windows");
  });

  it("rejects unknown process or wire values", () => {
    expect(() => normalizeWirePlatform("aix")).toThrow("invalid wire platform");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

```bash
pnpm vitest run shared/runtime-profile.test.ts shared/runtime-platform.test.ts
```

Expected: FAIL because the shared profile and platform modules do not exist.

- [ ] **Step 3: Implement the fixed runtime profile contract**

```ts
export const RUNTIME_PROFILES = [
  "desktop-hub",
  "headless-hub",
  "desktop-client",
] as const;

export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

export function isRuntimeProfile(value: unknown): value is RuntimeProfile {
  return (
    typeof value === "string" &&
    (RUNTIME_PROFILES as readonly string[]).includes(value)
  );
}

export function normalizeRuntimeProfile(value: unknown): RuntimeProfile {
  if (value === undefined || value === null || value === "") {
    return "desktop-hub";
  }
  if (!isRuntimeProfile(value)) throw new Error("invalid runtime profile");
  return value;
}
```

Implement the platform module beside it. Keep the canonical transport type
separate from Node's process type so a `win32` value can never leak onto the
wire:

```ts
export const WIRE_PLATFORMS = ["darwin", "windows", "linux"] as const;
export type WirePlatform = (typeof WIRE_PLATFORMS)[number];

export function isWirePlatform(value: unknown): value is WirePlatform {
  return typeof value === "string" && (WIRE_PLATFORMS as readonly string[]).includes(value);
}

export function normalizeWirePlatform(value: unknown): WirePlatform {
  if (value === "win32") return "windows";
  if (isWirePlatform(value)) return value;
  throw new Error("invalid wire platform");
}
```

- [ ] **Step 4: Run the focused test**

```bash
pnpm vitest run shared/runtime-profile.test.ts shared/runtime-platform.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/runtime-profile.ts shared/runtime-profile.test.ts shared/runtime-platform.ts shared/runtime-platform.test.ts
git commit -m "feat(runtime): define V Bot profiles and wire platform"
```

- [ ] **Step 6: Add the runtime-profile parity assertion**

The control-plane Worker must derive its `z.enum` (or equivalent strict
validator) from `RUNTIME_PROFILES`. Add a test that imports the shared list and
the Worker-exposed list/schema, enumerates every value, and asserts exact order
and membership. The test fails if a future Worker edit adds, removes, or
reorders a profile without changing the shared source. Keep `Node Only` and
`Hub plus Node` out of this enum: they are deployment compositions introduced
in Wave 4.

Run it with the control-plane workspace test command (or its focused form):

```bash
pnpm --filter @openmausbot/control-plane exec vitest run test/runtime-profile-parity.test.ts
```

---

### Task 2: Add stable Electron-compatible hub identity

**Files:**
- Create: `shared/hub-identity.mjs`
- Create: `shared/hub-identity.test.mjs`

**Interfaces:**

```js
/** @typedef {{ schemaVersion: 1, id: string, createdAt: number }} HubIdentity */

export class HubIdentityUnavailableError extends Error {}

export function readHubIdentity(options = {})
// -> { status: "missing" }
//  | { status: "ok", identity: HubIdentity }
//  | { status: "unavailable", error: string }

export function loadOrCreateHubIdentity(options = {})
// options: { dataDir, preferredId, allowCreate, now, randomId }
// -> HubIdentity
```

- [ ] **Step 1: Write failing identity tests**

Cover these exact cases:

```js
it("creates hub.json once with mode 0600 and reuses it", () => {
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
  const identity = loadOrCreateHubIdentity({
    dataDir,
    preferredId: "legacy-client-instance-A",
    now: () => 123,
  });
  assert.equal(identity.id, "legacy-client-instance-A");
});

it("fails closed when an existing identity is malformed", () => {
  writeFileSync(join(dataDir, "hub.json"), "not-json", { mode: 0o600 });
  assert.throws(
    () => loadOrCreateHubIdentity({ dataDir }),
    HubIdentityUnavailableError,
  );
  assert.equal(readFileSync(join(dataDir, "hub.json"), "utf8"), "not-json");
});

it("refuses first creation while the legacy credential state is unknown", () => {
  assert.throws(
    () => loadOrCreateHubIdentity({ dataDir, allowCreate: false }),
    HubIdentityUnavailableError,
  );
  assert.equal(existsSync(join(dataDir, "hub.json")), false);
});
```

Also test strict schema version, opaque-ID validation (non-empty bounded
printable strings; no UUID requirement), safe integer timestamp, invalid
preferred ID, immutable persisted ID, directory mode `0700`, and successful
reads when `allowCreate` is false but a valid identity already exists. Include
an existing non-UUID ID with punctuation to prove it is adopted unchanged.

- [ ] **Step 2: Run the test and confirm failure**

```bash
node --test shared/hub-identity.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement identity parsing and creation**

Creation shape:

```js
const identity = Object.freeze({
  schemaVersion: 1,
  id: preferredId || randomId(),
  createdAt: now(),
});
```

Required details:

- use only Node built-ins so Electron can import the module directly;
- create the data directory recursively with mode `0700`;
- if `hub.json` exists, parse and strictly validate it;
- if existing bytes are unreadable or invalid, return unavailable from `readHubIdentity()` and throw `HubIdentityUnavailableError` from `loadOrCreateHubIdentity()` without changing the file;
- if absent and `allowCreate === false`, throw without creating files;
- validate `preferredId` as a non-empty bounded opaque string; otherwise use
  `randomUUID()` only for a newly minted identity;
- write a temporary file in the same directory with `openSync(..., 0o600)`, write
  all bytes, `fsyncSync()`, and close it before publication;
- publish with an exclusive no-overwrite operation (`copyFileSync(...,
  COPYFILE_EXCL)` or the platform equivalent). Do not use a replace-rename
  operation: the destination must never be overwritten;
- if another writer wins first, reread the destination and adopt its valid
  identity. If the destination is unreadable or malformed, fail closed rather
  than treating it as empty, retrying with a new ID, or overwriting it;
- a concurrent reader may transiently observe the destination as unavailable
  while the exclusive copy is in progress. If a crash leaves a partial
  destination, it remains unavailable for manual recovery; it is never treated
  as empty or reminted.
- never change a valid persisted identity because a later preferred ID differs.

`hub.json` lives under the canonical runtime data directory: the final
Electron `app.getPath("userData")`, or the explicit headless `--data-dir`.
Never fall back to a second home-directory identity path.

The legacy secure credential field `companionClientInstanceId` is an alias,
not a second identity. On first creation, a valid opaque value in that field is
adopted as `hub.json.id`; when `hub.json` already exists, its valid ID wins and
the field is rewritten to that exact ID before registration. Cleanup reads the
reconciled ID and matches installations by it even when it is not UUID-shaped.
An invalid or unreadable existing field is not silently converted into a new
ID while the identity decision is unknown.

- [ ] **Step 4: Run focused tests**

```bash
node --test shared/hub-identity.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/hub-identity.mjs shared/hub-identity.test.mjs
git commit -m "feat(runtime): persist stable hub identity"
```

---

### Task 3: Add the headless encrypted secret store

**Files:**
- Create: `server/host-secret-store.ts`
- Create: `server/host-secret-store.test.ts`

**Interfaces:**

```ts
export type HostSecretSnapshot =
  | { status: "empty"; values: Record<string, string> }
  | { status: "ok"; values: Record<string, string> }
  | { status: "unavailable"; values: Record<string, never>; error: string };

export class HostSecretStoreUnavailableError extends Error {}

export interface HostSecretStore {
  read(): HostSecretSnapshot;
  set(name: string, value: string): void;
  delete(name: string): void;
}

export function createFileEnvelopeSecretStore(options?: {
  dataDir: string;
  randomBytes?: (size: number) => Buffer;
}): HostSecretStore;
```

- [ ] **Step 1: Write failing secret-store tests**

```ts
it("returns empty only when no envelope exists", () => {
  expect(store.read()).toEqual({ status: "empty", values: {} });
});

it("encrypts values and never writes their plaintext", () => {
  store.set("controlPlaneAccountToken", "account-token-value-1234567890");
  const bytes = readFileSync(join(dataDir, "host-secrets.bin"));
  expect(bytes.includes(Buffer.from("account-token-value-1234567890"))).toBe(false);
  expect(store.read()).toEqual({
    status: "ok",
    values: { controlPlaneAccountToken: "account-token-value-1234567890" },
  });
});

it("uses mode 0600 for key and envelope", () => {
  store.set("x", "12345678901234567890");
  expect(statSync(join(dataDir, "host-secret.key")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dataDir, "host-secrets.bin")).mode & 0o777).toBe(0o600);
});

it("does not overwrite a corrupt existing envelope", () => {
  writeFileSync(join(dataDir, "host-secrets.bin"), "corrupt", { mode: 0o600 });
  expect(store.read().status).toBe("unavailable");
  expect(() => store.set("replacement", "12345678901234567890")).toThrow(
    HostSecretStoreUnavailableError,
  );
  expect(readFileSync(join(dataDir, "host-secrets.bin"), "utf8")).toBe("corrupt");
});
```

Also test authenticated-decryption failure with the wrong key, deletion of the last value, key names matching `/^[A-Za-z][A-Za-z0-9._-]{0,127}$/`, values from 1 through 32,768 UTF-8 bytes, and immutable returned maps.

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm vitest run server/host-secret-store.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the envelope**

Use Node `crypto` with this on-disk JSON envelope:

```ts
interface SecretEnvelopeV1 {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}
```

Implementation requirements:

- create a 32-byte random key once in `host-secret.key`;
- use a 12-byte random IV per write;
- bind authenticated additional data `vbot-host-secrets-v1`;
- encrypt canonical JSON containing only validated string keys and values;
- encode binary fields as base64url;
- write atomically with mode `0600`;
- decrypt and validate every existing envelope before mutation;
- map parse, read, key, and authentication failures to `status = unavailable` without including bytes or secret values in the error;
- document that this protects archives and accidental plaintext exposure, not a host compromised as root.

`dataDir` is required and must be the canonical headless runtime directory;
the store must not infer a path from the current directory or home directory.
The resulting `host-secret.key` and `host-secrets.bin` files are part of the
runtime backup/export surface. Add a temporary-directory backup fixture only
if the existing backup tooling does not already include both files; never copy
or upload a production secret during this task.

- [ ] **Step 4: Run focused tests**

```bash
pnpm vitest run server/host-secret-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/host-secret-store.ts server/host-secret-store.test.ts
git commit -m "feat(secrets): add encrypted headless host store"
```

---

### Task 4: Add fleet presence to the control plane

**Files:**
- Create: `cloudflare/control-plane/migrations/0006_fleet_presence.sql`
- Create: `cloudflare/control-plane/src/fleet.ts`
- Create: `cloudflare/control-plane/test/fleet.test.ts`
- Create: `cloudflare/control-plane/test/runtime-profile-parity.test.ts`
- Modify: `cloudflare/control-plane/src/installations.ts`
- Modify: `cloudflare/control-plane/src/index.ts`
- Modify: `cloudflare/control-plane/README.md`

**Interfaces:**

```ts
export async function updateInstallationPresence(
  request: Request,
  env: Env,
): Promise<Response>;

export async function listFleet(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response>;
```

- [ ] **Step 1: Write the additive migration**

```sql
ALTER TABLE installations
  ADD COLUMN runtime_profile TEXT NOT NULL DEFAULT 'desktop-hub';

ALTER TABLE installations
  ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE installations
  ADD COLUMN presence_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS installations_owner_presence_idx
  ON installations(owner_user_id, presence_updated_at);
```

Do not rebuild or drop the existing table in this wave.

- [ ] **Step 2: Write failing Worker tests**

Create tests for:

1. an installation credential can `PUT /v1/installations/self/presence` with:

```json
{
  "runtimeProfile": "headless-hub",
  "appVersion": "0.1.37",
  "capabilities": ["companion", "managed-endpoint"]
}
```

2. an account bearer cannot call the self presence route;
3. an installation credential cannot call `GET /v1/fleet`;
4. one account sees only its own installations;
5. legacy rows default to `desktop-hub` and empty capabilities;
6. capability values are unique, sorted, match `/^[a-z][a-z0-9-]{0,63}$/`, and are limited to 32 entries;
7. unknown runtime profiles and extra JSON keys return `400 invalid_request`;
8. `online` is true through 90,000 milliseconds after `presence_updated_at` and false after that boundary;
9. fleet endpoint metadata contains HTTPS origin and lifecycle status only;
10. no credential, tunnel ID, DNS ID, connector token, owner ID, or email appears in the payload.
11. an existing opaque `clientInstanceId` such as `legacy-client-instance-A`
    is accepted and returned unchanged; UUID syntax is not required. Empty,
    control-character, over-limit, or non-string IDs fail closed.
12. the platform validator accepts only `darwin`, `windows`, and `linux`; a
    `win32` value is rejected here because mapping happens before the request
    reaches the Worker.
13. the Worker runtime-profile schema is derived from `shared/runtime-profile.ts`;
    the parity test enumerates the shared list and the Worker list and fails on
    any add/remove/reorder drift.

- [ ] **Step 3: Run the test and confirm failure**

```bash
pnpm --filter @openmausbot/control-plane exec vitest run test/fleet.test.ts
```

Expected: FAIL because the route and migration do not exist.

- [ ] **Step 4: Implement strict presence validation**

```ts
const presenceSchema = z.strictObject({
  // Import RUNTIME_PROFILES from shared/runtime-profile.ts (or a generated
  // re-export) instead of maintaining a second literal list.
  runtimeProfile: z.enum(RUNTIME_PROFILES),
  appVersion: z.string().trim().min(1).max(64).optional(),
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
    .max(32),
});
```

Normalize capabilities with `Array.from(new Set(values)).sort()`. Store the JSON string and update `app_version`, `last_seen_at`, `presence_updated_at`, and `updated_at` in one statement scoped to the authenticated installation ID.

Keep the Worker platform schema aligned with `WIRE_PLATFORMS` from
`shared/runtime-platform.ts`. The Worker accepts canonical wire values only;
the Node runtime's `win32` mapping is tested at the boundary and is never
duplicated in the Worker.

Update the existing installation-create validator and all Worker/native
installation decoders to use the same bounded printable opaque-ID rule for
`clientInstanceId` (and for server-returned installation IDs where they are
read). Do not apply a UUID regex to adopted values. The server may continue to
mint UUID installation IDs, but readers and cleanup must accept a valid legacy
opaque ID unchanged.

- [ ] **Step 5: Implement fleet listing**

Join active installations to `installation_endpoints` by installation ID. Return:

```ts
{
  installations: [
    {
      id,
      clientInstanceId,
      name,
      platform,
      runtimeProfile,
      appVersion,
      capabilities,
      lastSeenAt,
      online,
      endpoint: endpointStatus === "deleted" ? null : {
        url: `https://${hostname}`,
        status: endpointStatus,
      },
    },
  ],
}
```

Sort by `created_at ASC, id ASC`, matching existing installation ordering. Invalid stored `capabilities_json` decodes to `[]` instead of failing the account response. Invalid stored `runtime_profile` publishes `desktop-hub` and is corrected by the next valid presence update.

- [ ] **Step 6: Wire routes**

```ts
if (request.method === "GET" && url.pathname === "/v1/fleet") {
  return listFleet(request, env, auth);
}
if (
  request.method === "PUT" &&
  url.pathname === "/v1/installations/self/presence"
) {
  return updateInstallationPresence(request, env);
}
```

Keep `/v1/installations` compatible for existing desktop callers. Safe optional fields may be added to `installationJSON()`, but existing fields and status codes cannot change.

- [ ] **Step 7: Run all control-plane checks**

```bash
pnpm control-plane:types
pnpm control-plane:check
pnpm control-plane:test
pnpm control-plane:dry-run
```

Expected: PASS with no remote resource changes.

- [ ] **Step 8: Commit**

```bash
git add cloudflare/control-plane
git commit -m "feat(control-plane): add hub fleet presence"
```

---

### Task 5: Extract and extend the shared control-plane client

**Files:**
- Create: `shared/control-plane-client.mjs`
- Create: `shared/control-plane-client.test.mjs`
- Modify: `electron/control-plane-client.mjs`
- Modify: `electron/control-plane-client.test.mjs`

**Interfaces:**
- Preserve every existing export and method.
- Add:

```js
client.listFleet(accountToken)
client.updatePresence(installationCredential, {
  runtimeProfile,
  appVersion,
  capabilities,
})
```

- [ ] **Step 1: Move the existing pure client without behavioral changes**

Copy the current implementation from `electron/control-plane-client.mjs` to `shared/control-plane-client.mjs`. Replace the Electron file with:

```js
export * from "../shared/control-plane-client.mjs";
```

- [ ] **Step 2: Run existing client tests**

```bash
node --test electron/control-plane-client.test.mjs
```

Expected: PASS unchanged.

- [ ] **Step 3: Commit the extraction**

```bash
git add shared/control-plane-client.mjs electron/control-plane-client.mjs
git commit -m "refactor(account): share control-plane client"
```

- [ ] **Step 4: Write failing fleet client tests**

Test strict decoding of this response (the IDs are shown in UUID form only
because the fixture is newly minted; the decoder must also accept existing
opaque IDs):

```json
{
  "installations": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "clientInstanceId": "22222222-2222-4222-8222-222222222222",
      "name": "Home hub",
      "platform": "linux",
      "runtimeProfile": "headless-hub",
      "appVersion": "0.1.37",
      "capabilities": ["companion"],
      "lastSeenAt": 1700000000000,
      "online": true,
      "endpoint": {
        "url": "https://c-0123456789abcdef0123456789abcdef.example.com",
        "status": "ready"
      }
    }
  ]
}
```

Reject non-HTTPS endpoints, unknown top-level installation keys, unknown endpoint keys, malformed capability names, duplicate capabilities, unknown profiles, oversized lists, and invalid timestamps.

Verify `updatePresence()` sends `PUT`, an installation bearer, the exact JSON body, `redirect: error`, and no account-auth `Origin` header.

The strict decoder is the primary boundary: unknown top-level or nested keys,
malformed IDs, duplicate capabilities, invalid timestamps, profiles, platforms,
or endpoint origins reject the entire response. It must never silently pass a
credential-shaped field to a native client.

- [ ] **Step 5: Implement safe fleet validation**

Return only:

```js
{
  id,
  clientInstanceId,
  name,
  platform,
  runtimeProfile,
  appVersion,
  capabilities,
  lastSeenAt,
  online,
  endpoint,
}
```

Reject enumerable keys outside the explicit installation and endpoint allowlists. This prevents a future server regression from passing credential-shaped fields into native clients.

Keep CLI redaction separate from this decoder. Add a test-only serializer input
that bypasses the decoder with an object containing keys ending in `token`,
`credential`, `secret`, `password`, or `key`; assert that the CLI replaces those
values before printing. This is defense-in-depth for a mocked/legacy dependency
and is not permission to loosen strict response validation or to print a
partially accepted response.

- [ ] **Step 6: Run shared and Electron client tests**

```bash
node --test shared/control-plane-client.test.mjs electron/control-plane-client.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  shared/control-plane-client.mjs \
  shared/control-plane-client.test.mjs \
  electron/control-plane-client.test.mjs
git commit -m "feat(account): add safe fleet client"
```

---

### Task 6: Add headless hub account orchestration and CLI

**Files:**
- Create: `runtime/src/hub-account.ts`
- Create: `runtime/src/hub-account.test.ts`
- Create: `runtime/src/cli.ts`
- Create: `runtime/src/cli.test.ts`
- Create: `tsconfig.runtime.build.json`
- Modify: `package.json`

**Interfaces:**

```ts
export interface HubAccountState {
  accountEmail?: string;
  installationId?: string;
  credentialExpiresAt?: number;
}

export function createHubAccountService(dependencies: {
  client: ReturnType<typeof createControlPlaneClient>;
  identity: { schemaVersion: 1; id: string; createdAt: number };
  profile: "headless-hub";
  platform: "darwin" | "windows" | "linux";
  appVersion: string;
  displayName: string;
  secrets: HostSecretStore;
  now?: () => number;
}): {
  requestCode(email: string): Promise<{ email: string }>;
  verifyCode(email: string, otp: string): Promise<HubAccountState>;
  register(): Promise<HubAccountState>;
  heartbeat(): Promise<void>;
  fleet(): Promise<FleetInstallation[]>;
  stopPresence(): void;
  dispose(): Promise<void>;
  signOut(): Promise<void>;
};
```

- [ ] **Step 1: Write failing service tests**

Use a fake control-plane client and real temporary identity/secret stores. Test:

- request-code returns normalized email and stores no credential;
- verify-code stores account token and normalized email;
- register uses `identity.id` as `clientInstanceId`;
- a valid stored installation credential is reused;
- a definitive 401 from the self route permits account recovery;
- network and unavailable errors do not rotate or replace the stored credential;
- heartbeat sends `headless-hub`, package version, and sorted `[
  "companion",
  "harness"
]`;
- heartbeat sends only canonical wire platforms; a Windows runtime is
  normalized from Node `win32` to `windows` before the request;
- an unavailable secret store blocks registration before any network write;
- `stopPresence()` is idempotent and prevents future heartbeats; `dispose()` is
  idempotent, calls `stopPresence()`, and waits for in-flight presence work;
- headless sign-out calls `stopPresence()`, removes only the account bearer,
  and retains `hub.json`, the adopted installation ID, and the encrypted
  installation credential; it does not silently revoke or delete the
  installation;
- public returned state contains no token or credential.

- [ ] **Step 2: Run the service test and confirm failure**

```bash
pnpm vitest run runtime/src/hub-account.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service**

Use these fixed secret names:

```ts
const ACCOUNT_TOKEN = "controlPlane.accountToken";
const ACCOUNT_EMAIL = "controlPlane.accountEmail";
const INSTALLATION_ID = "controlPlane.installationId";
const INSTALLATION_CREDENTIAL = "controlPlane.installationCredential";
const INSTALLATION_EXPIRY = "controlPlane.installationCredentialExpiresAt";
```

Never return values for keys ending in `Token`, `Credential`, or `Secret`. On any mutation, reread and validate the store before writing. An unavailable snapshot throws `HostSecretStoreUnavailableError` without calling the network.

Construct the control-plane client with an explicit `baseURL`. Production uses
the packaged HTTPS origin; local smoke injects only a loopback origin such as
`http://127.0.0.1:8787` through test dependencies or `OMB_CONTROL_PLANE_URL`.
Do not add a Worker route or a default that makes the loopback origin
production-reachable.

- [ ] **Step 4: Write failing CLI parser tests**

Wave 1 commands are (all headless invocations require the global absolute
`--data-dir` option):

```text
vbotctl --data-dir <absolute-path> account request-code --email <address>
vbotctl --data-dir <absolute-path> account verify-code --email <address>
vbotctl --data-dir <absolute-path> account verify-code --email <address> --stdin
vbotctl --data-dir <absolute-path> hub register --name <display-name>
vbotctl --data-dir <absolute-path> hub heartbeat --once
vbotctl --data-dir <absolute-path> fleet list --json
vbotctl --data-dir <absolute-path> account sign-out
```

Tests must verify:

- unknown commands exit `2`;
- missing arguments exit `2`;
- missing or relative `--data-dir` exits `2` before reading secrets or making a network call;
- verification code is read through an injected hidden prompt or stdin, never argv;
- prompt and stdin contents are never included in error output;
- `fleet list` redacts unexpected keys ending in `token`, `credential`, `secret`, `password`, or `key` before JSON output;
- `hub heartbeat` requires `--once` in Wave 1 so this CLI does not pretend to be a service supervisor;
- success output never includes account or installation credentials.

- [ ] **Step 5: Implement the CLI with dependency injection**

Export `runVbotctl(argv, dependencies)` for tests and invoke it only when the module is executed directly. Use `node:readline/promises` for hidden interactive entry and raw stdin for `--stdin`. Do not accept a verification code, bearer, or installation credential as a command-line option.

- [ ] **Step 6: Add build and package scripts**

Create `tsconfig.runtime.build.json` with NodeNext settings, `allowJs: true`, and includes for:

```text
runtime/src/**/*.ts
server/host-secret-store.ts
shared/hub-identity.mjs
shared/control-plane-client.mjs
shared/runtime-profile.ts
shared/runtime-platform.ts
```

Use an isolated `dist-runtime/` output directory already covered by `.gitignore`, or add that exact directory to `.gitignore` in this task.

Add:

```json
{
  "scripts": {
    "build:runtime": "tsc -p tsconfig.runtime.build.json",
    "test:runtime": "vitest run runtime/src server/host-secret-store.test.ts shared/runtime-profile.test.ts shared/runtime-platform.test.ts && node --test shared/hub-identity.test.mjs shared/control-plane-client.test.mjs",
    "vbotctl": "node --experimental-strip-types runtime/src/cli.ts"
  }
}
```

Do not add `build:runtime` to `package:prepare` in Wave 1. Distribution integration belongs to Wave 6.

- [ ] **Step 7: Run runtime tests and build**

```bash
pnpm test:runtime
pnpm build:runtime
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add runtime tsconfig.runtime.build.json package.json pnpm-lock.yaml .gitignore
git commit -m "feat(runtime): add headless hub account CLI"
```

---

### Task 7: Integrate stable identity and presence into Electron

**Files:**
- Modify: `electron/companion-account-service.mjs`
- Modify: `electron/companion-account-service.test.mjs`
- Modify: `electron/main.mjs`
- Add a focused Node test file if `main.mjs` identity wiring cannot be exercised without launching Electron.

**Interfaces:**
- Consumes: `readHubIdentity()`, `loadOrCreateHubIdentity()`, and shared control-plane `updatePresence()`.
- Preserves: every current companion account state and managed endpoint method.
- Adds explicit idempotent `stopPresence()` and `dispose()` lifecycle methods;
  `signOut()` and app quit must invoke them.

- [ ] **Step 1: Write failing account-service presence tests**

Inject these new dependencies into `createCompanionAccountService()`:

```js
runtimeProfile = "desktop-hub",
appVersion = "",
capabilities = ["companion", "harness"],
schedulePresence = (work) => setInterval(work, 60_000),
clearPresence = clearInterval,
```

Test:

- presence runs after a valid installation credential is available;
- initial presence is sent before the service reports settled `ready`;
- heartbeat interval is 60 seconds and calls `unref()` when supported;
- explicit `stopPresence()` is idempotent and stops the timer;
- explicit `dispose()` is idempotent, calls `stopPresence()`, and waits for an
  in-flight presence request;
- sign-out calls `stopPresence()` before the existing endpoint deletion and
  installation revocation cleanup;
- a heartbeat network failure changes no local credential or endpoint state;
- a presence 401 surfaces an account reconnect error but does not create a replacement installation automatically;
- capabilities are sorted and unique.

- [ ] **Step 2: Run the focused Electron test and confirm failure**

```bash
node --test electron/companion-account-service.test.mjs
```

Expected: FAIL on missing presence behavior.

- [ ] **Step 3: Adopt the existing Electron installation identity safely**

At startup, before account provisioning:

1. call `readHubIdentity({ dataDir: app.getPath("userData") })` after the
   existing compatibility-path selection has run;
2. when it returns `ok`, use that identity even if Electron `safeStorage` is temporarily unavailable;
3. when it returns `unavailable`, surface the identity error and do not alter secure credentials;
4. when it returns `missing`, read secure credentials using the existing unavailable/empty/ok distinction;
5. if secure credentials are unavailable, call no create function and surface the credential-store error;
6. if credentials are readable, obtain `COMPANION_CLIENT_INSTANCE_FIELD` as the
   preferred opaque ID and call `loadOrCreateHubIdentity({ preferredId,
   allowCreate: true })`; do not require UUID syntax;
7. persist `hubIdentity.id` back into `COMPANION_CLIENT_INSTANCE_FIELD` when it
   is missing, malformed, or differs, so the legacy field and `hub.json` are
   reconciled before registering the installation;
8. inject `hubIdentity.id` wherever the companion account service currently requests `identity.clientInstanceId`.

The reconciled `hubIdentity.id` is also the cleanup match key. Existing
installation IDs and client-instance IDs are opaque; do not skip cleanup just
because a value is not UUID-shaped. A malformed `hub.json` remains unavailable
and must not be overwritten to make cleanup pass.

Do not change the existing installation credential or managed endpoint field names.

- [ ] **Step 4: Implement presence scheduling**

After `ensureInstallation()` succeeds, call:

```js
await client.updatePresence(installationCredential, {
  runtimeProfile: "desktop-hub",
  appVersion,
  capabilities: ["companion", "desktop-ui", "harness"],
});
```

Schedule the same call every 60 seconds while signed in. Stop the timer during service disposal, account sign-out, and app quit.

Wire Electron's app-quit handler to await the account service's `dispose()` in
the existing bounded cleanup promise. Do not rely on process exit to cancel an
interval or leave an in-flight presence request unobserved.

- [ ] **Step 5: Run Electron account tests**

```bash
node --test \
  shared/hub-identity.test.mjs \
  shared/control-plane-client.test.mjs \
  electron/control-plane-client.test.mjs \
  electron/companion-account-service.test.mjs \
  electron/secure-credentials.test.mjs \
  electron/workspace-credentials.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run desktop build checks**

```bash
pnpm typecheck
pnpm build
pnpm test:updater
pnpm test:package-link
pnpm test:packaged-server
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron
git commit -m "feat(desktop): publish stable hub presence"
```

---

### Task 8: Documentation, compatibility audit, and Wave 1 verification

**Files:**
- Modify: `README.md`
- Modify: `docs/cloud-vps-hosting.md`
- Modify: `cloudflare/control-plane/README.md`
- Modify generated Worker configuration typings only when the existing type-generation command changes them.
- Create only if the local smoke harness has no equivalent: `cloudflare/control-plane/test/local-mail-fixture.ts` (an in-memory `EMAIL.send` binding helper; never imported by production Worker code).

- [ ] **Step 1: Document the trust split**

State explicitly:

- account login discovers systems and owns endpoints;
- pairing still grants hub access;
- the control plane has no chats or provider secrets;
- headless secrets live in the encrypted host store;
- Electron's canonical hub directory is the final `app.getPath("userData")`;
- headless commands require an explicit absolute `--data-dir` (with
  `OMB_DATA_DIR` allowed only for local tests);
- `hub.json` and the encrypted secret-store files are included in hub backups
  and migrations;
- `stopPresence()` and `dispose()` are called on sign-out and app quit;
- Node Only and Hub plus Node are deployment compositions deferred to Wave 4,
  not Wave 1 runtime roles;
- deleting `hub.json` creates a new hub identity and is never a normal troubleshooting step.

- [ ] **Step 2: Document Wave 1 headless commands**

Use interactive verification:

```bash
pnpm run vbotctl -- --data-dir /var/lib/vbot account request-code --email owner@example.com
pnpm run vbotctl -- --data-dir /var/lib/vbot account verify-code --email owner@example.com
pnpm run vbotctl -- --data-dir /var/lib/vbot hub register --name "Home V Bot"
pnpm run vbotctl -- --data-dir /var/lib/vbot hub heartbeat --once
pnpm run vbotctl -- --data-dir /var/lib/vbot fleet list --json
```

For non-interactive local tests, pipe only the short-lived verification code through stdin:

```bash
printf '%s\n' '12345678' | \
  pnpm run vbotctl -- --data-dir "$OMB_DATA_DIR" account verify-code --email owner@example.com --stdin
```

`--data-dir` is required for a headless runtime and must be absolute. Set
`OMB_DATA_DIR` only in local tests when the CLI's dependency-injected fixture
explicitly permits it. Do not claim a background heartbeat service exists in
Wave 1.

- [ ] **Step 3: Audit for secret leakage and unfinished markers**

Review all new and modified files for incomplete markers, vague error branches, credential-shaped fixtures, and accidental plaintext. Then run:

```bash
rg -n "controlPlane(AccountToken|InstallationCredential)|omb_install_|set-auth-token" \
  runtime cloudflare/control-plane electron shared
```

Every match must be a fixed field name, parser, validator, or intentionally invalid fixture. No production log, thrown message, snapshot, fleet payload, or command argument may include a real-shaped credential.

In the same review, inspect the existing backup/export tooling's include and
exclude rules. A canonical headless archive must contain `hub.json`,
`host-secret.key`, and `host-secrets.bin`; an Electron archive must contain
`hub.json` and its OS-encrypted credential file under `app.getPath("userData")`.
If the current scripts already copy the selected runtime directory recursively,
add only a temporary-directory assertion that those files survive a dry-run
round trip. If they omit a file, make the smallest additive include/test change
and run it locally; do not invoke a remote backup, upload, restore, or deploy.

- [ ] **Step 4: Run the complete Wave 1 verification gate**

```bash
pnpm install --frozen-lockfile
pnpm test:runtime
pnpm build:runtime
pnpm control-plane:types
pnpm control-plane:check
pnpm control-plane:test
pnpm control-plane:dry-run
node --test \
  shared/hub-identity.test.mjs \
  shared/control-plane-client.test.mjs \
  electron/control-plane-client.test.mjs \
  electron/companion-account-service.test.mjs \
  electron/secure-credentials.test.mjs \
  electron/workspace-credentials.test.mjs
pnpm typecheck
pnpm build
node scripts/test-floor.mjs
cd ios && swift test
```

The iOS test suite must remain unchanged and pass because this wave does not modify the phone contract.

- [ ] **Step 5: Perform a local fixture smoke test**

Use only local Wrangler/D1 and a temporary data directory:

```bash
export OMB_DATA_DIR="$(mktemp -d)"
export CONTROL_PLANE_PORT=8787
export OMB_CONTROL_PLANE_URL="http://127.0.0.1:${CONTROL_PLANE_PORT}"
pnpm --filter @openmausbot/control-plane exec wrangler d1 migrations apply DB \
  --local --config wrangler.jsonc
```

Copy `.dev.vars.example` to a temporary, untracked `.dev.vars` with
test-only placeholder values, and start the Worker on the explicit loopback
URL (use another explicitly exported port if `8787` is occupied):

```bash
pnpm --filter @openmausbot/control-plane exec wrangler dev \
  --local --config wrangler.jsonc --port "$CONTROL_PLANE_PORT"
```

The mail fixture replaces only the local test `EMAIL` binding and captures the
latest OTP message in memory. It exposes `readLatestOtp(email)` to the smoke
harness, not through an HTTP route, Worker environment variable, or production
build. Then:

1. request an OTP over `OMB_CONTROL_PLANE_URL` and read the short-lived code
   through `readLatestOtp(email)`;
2. pipe that code to `pnpm run vbotctl -- --data-dir "$OMB_DATA_DIR" account
   verify-code` with the same explicit URL;
3. run headless register;
4. run one heartbeat;
5. list fleet;
6. restart the CLI with the same `OMB_DATA_DIR` and confirm no second
   installation is created;
7. stop the Worker and confirm fleet/presence failures do not alter `hub.json`
   or the stored installation credential.

Do not use production credentials or endpoint provisioning in this smoke test.
The fixture must not add a static OTP, bypass signature/rate-limit checks, or
expose a test-only HTTP endpoint. Delete the temporary `.dev.vars`, data
directory, and mail capture after the run.

- [ ] **Step 6: Review the final diff**

```bash
git status --short --branch
git diff --check
git diff --stat vbot-private/main...HEAD
git log --oneline --decorate vbot-private/main..HEAD
```

Verify the diff contains only Wave 1 work.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md docs/cloud-vps-hosting.md cloudflare/control-plane/README.md
git commit -m "docs(vbot): document hub fleet foundation"
```

- [ ] **Step 8: Push the implementation branch**

```bash
git push -u vbot-private feat/vbot-hub-fleet-foundation
```

Do not open or merge a pull request until the final report identifies the exact commits, test results, baseline deviations, and remaining Wave 2 dependencies.

---

## Completion report format

The implementing Codex session must report:

```text
Worktree:
Branch:
Base commit:
Final commit(s):

Implemented:
- stable hub identity
- headless host secret store
- fleet presence API
- shared control-plane client
- headless account CLI
- desktop presence integration

Verification:
- focused tests:
- control-plane checks:
- typecheck/build:
- test floor:
- iOS Swift tests:
- local fixture smoke:

Security review:
- account vs pairing boundary:
- secret leakage scan:
- compatibility behavior:

Not implemented in Wave 1:
- client account UI
- pairing invitations
- provider connection lifecycle
- node v2
- execution targets
- production deployment
```
