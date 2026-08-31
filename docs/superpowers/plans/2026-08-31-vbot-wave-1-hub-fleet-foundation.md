# V Bot Wave 1 Hub and Fleet Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every V Bot hub a stable local identity and runtime profile, add a safe headless secret store, and extend the existing account control plane with presence and read-only fleet discovery without changing companion pairing or mobile authorization.

**Architecture:** A stable `hub.json` identity becomes the control-plane `clientInstanceId`. Desktop hubs keep Electron `safeStorage`; headless hubs use an AES-256-GCM envelope backed by a separately stored mode-0600 host key. Installations heartbeat safe runtime metadata to the control plane, and account-authenticated callers list owned hubs through `/v1/fleet`. The data plane remains hub-to-client pairing through the existing companion.

**Tech Stack:** TypeScript, Node.js 24+, Electron ESM, Cloudflare Workers, D1 SQLite migrations, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-vbot-distributed-platform-design.md`

## Global Constraints

- Implement in `/Users/Vincent/Github/.worktrees/vbot-wave1-hub-fleet` on branch `feat/vbot-hub-fleet-foundation` based on the current `vbot-private/main`.
- Do not implement iOS account login, pairing invitations, provider connections, node v2, execution targets, deployment, or TestFlight in this wave.
- Do not modify production Cloudflare resources, D1 databases, DNS, tunnels, Servarica, or the hosted Mac runtime.
- Existing desktop account sign-in and managed endpoint behavior must remain compatible.
- Existing installations created by older clients decode as `runtimeProfile = desktop-hub`, `capabilities = []`, and offline until their next presence update.
- Existing Electron installation identity must be adopted, not replaced.
- An invalid existing identity or secret store is an unavailable state. Never treat it as empty and never mint replacement credentials automatically.
- Account bearers are accepted only by account/fleet routes. Installation credentials are accepted only by self/presence/endpoint routes. Neither is accepted by companion.
- No secret value may be written to `config.json`, fleet metadata, logs, argv, test snapshots, or error messages.

---

## File map

### New shared and server files

- `shared/runtime-profile.ts`: runtime profile vocabulary and validation.
- `shared/control-plane-client.mjs`: environment-neutral control-plane client extracted from Electron.
- `server/hub-identity.ts`: stable identity file lifecycle.
- `server/hub-identity.test.ts`: identity creation, adoption, permissions, and corruption behavior.
- `server/host-secret-store.ts`: headless encrypted secret envelope.
- `server/host-secret-store.test.ts`: encryption, update, corruption, and write-permission behavior.

### New control-plane files

- `cloudflare/control-plane/migrations/0006_fleet_presence.sql`: safe installation presence columns.
- `cloudflare/control-plane/src/fleet.ts`: presence update and account fleet listing.
- `cloudflare/control-plane/test/fleet.test.ts`: ownership, auth separation, validation, and online-state tests.

### New headless runtime files

- `runtime/src/hub-account.ts`: account registration and presence orchestration.
- `runtime/src/hub-account.test.ts`: stable registration and failure behavior.
- `runtime/src/cli.ts`: Wave 1 `vbotctl` commands.
- `runtime/src/cli.test.ts`: argument parsing and secret-redaction tests.
- `tsconfig.runtime.build.json`: runtime build target.

### Existing files to modify

- `electron/control-plane-client.mjs`: compatibility re-export.
- `electron/control-plane-client.test.mjs`: preserve existing client behavior and cover the wrapper.
- `electron/companion-account-service.mjs`: attach runtime profile and presence heartbeat.
- `electron/companion-account-service.test.mjs`: stable identity and heartbeat tests.
- `electron/main.mjs`: load/adopt the stable hub identity before account provisioning.
- `cloudflare/control-plane/src/installations.ts`: return new safe installation fields with legacy defaults.
- `cloudflare/control-plane/src/index.ts`: route `/v1/fleet` and `/v1/installations/self/presence`.
- `cloudflare/control-plane/worker-configuration.d.ts`: migration-generated schema typing when required by the existing build.
- `cloudflare/control-plane/README.md`: document fleet metadata and trust separation.
- `package.json`: add runtime build/test/CLI scripts.
- `README.md`: document stable hub identity and headless registration commands.
- `docs/cloud-vps-hosting.md`: add non-production setup and presence verification.

---

### Task 1: Define runtime profiles

**Files:**
- Create: `shared/runtime-profile.ts`
- Create: `shared/runtime-profile.test.ts`

**Interfaces:**
- Produces: `RuntimeProfile`, `RUNTIME_PROFILES`, `isRuntimeProfile()`, `normalizeRuntimeProfile()`.
- Consumed by: control-plane fleet validation, Electron presence, headless runtime.

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

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm vitest run shared/runtime-profile.test.ts
```

Expected: FAIL because `shared/runtime-profile.ts` does not exist.

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

- [ ] **Step 4: Run the focused test**

```bash
pnpm vitest run shared/runtime-profile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/runtime-profile.ts shared/runtime-profile.test.ts
git commit -m "feat(runtime): define V Bot runtime profiles"
```

---

### Task 2: Add stable hub identity

**Files:**
- Create: `server/hub-identity.ts`
- Create: `server/hub-identity.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic()` from `server/atomic.ts`.
- Produces:

```ts
export interface HubIdentity {
  schemaVersion: 1;
  id: string;
  createdAt: number;
}

export class HubIdentityUnavailableError extends Error {}

export function loadOrCreateHubIdentity(options?: {
  dataDir?: string;
  preferredId?: string;
  now?: () => number;
  randomId?: () => string;
}): HubIdentity;
```

- [ ] **Step 1: Write failing identity tests**

Cover these exact cases:

```ts
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
  expect(second).toEqual(first);
  expect(statSync(join(dataDir, "hub.json")).mode & 0o777).toBe(0o600);
});

it("adopts an existing Electron client instance id only on first creation", () => {
  const identity = loadOrCreateHubIdentity({
    dataDir,
    preferredId: "33333333-3333-4333-8333-333333333333",
    now: () => 123,
  });
  expect(identity.id).toBe("33333333-3333-4333-8333-333333333333");
});

it("fails closed when an existing identity is malformed", () => {
  writeFileSync(join(dataDir, "hub.json"), "not-json", { mode: 0o600 });
  expect(() => loadOrCreateHubIdentity({ dataDir })).toThrow(
    HubIdentityUnavailableError,
  );
  expect(readFileSync(join(dataDir, "hub.json"), "utf8")).toBe("not-json");
});

it("rejects a malformed preferred id", () => {
  expect(() =>
    loadOrCreateHubIdentity({ dataDir, preferredId: "same-name-new-machine" }),
  ).toThrow("invalid preferred hub id");
});
```

Also test schema version, UUID validation, integer timestamp, immutable persisted ID, and directory mode `0700`.

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm vitest run server/hub-identity.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement identity parsing and creation**

Use a strict Zod schema or explicit checks. Creation behavior:

```ts
const identity: HubIdentity = {
  schemaVersion: 1,
  id: preferredId ?? randomId(),
  createdAt: now(),
};
```

Required details:

- create the data directory recursively with mode `0700`;
- if `hub.json` exists, parse it and return it;
- if `hub.json` exists but is unreadable or invalid, throw `HubIdentityUnavailableError` and leave the bytes untouched;
- if absent, validate `preferredId`, otherwise use `randomUUID()`;
- write with `writeFileAtomic()` and mode `0600`;
- reread and validate the written value before returning;
- never change a valid persisted identity because a later `preferredId` differs.

- [ ] **Step 4: Run focused tests**

```bash
pnpm vitest run server/hub-identity.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hub-identity.ts server/hub-identity.test.ts
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

export interface HostSecretStore {
  read(): HostSecretSnapshot;
  set(name: string, value: string): void;
  delete(name: string): void;
}

export function createFileEnvelopeSecretStore(options?: {
  dataDir?: string;
  randomBytes?: (size: number) => Buffer;
}): HostSecretStore;
```

- [ ] **Step 1: Write failing secret-store tests**

Test these behaviors:

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
    "host secret store is unavailable",
  );
  expect(readFileSync(join(dataDir, "host-secrets.bin"), "utf8")).toBe("corrupt");
});
```

Also test authenticated-decryption failure with the wrong key, deletion of the last value, validation of names with `/^[A-Za-z][A-Za-z0-9._-]{0,127}$/`, bounded values of 1 to 32,768 bytes, and immutable input maps.

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
- bind the authenticated additional data string `vbot-host-secrets-v1`;
- encrypt canonical JSON containing only validated string keys and values;
- encode binary fields as base64url;
- write atomically with mode `0600`;
- decrypt and validate every existing envelope before mutation;
- map all parse, read, key, and authentication failures to `status = unavailable` without including bytes or secret values in the error;
- do not claim this protects against root on the host; document that it protects archives and accidental plaintext exposure.

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
- Modify: `cloudflare/control-plane/src/installations.ts`
- Modify: `cloudflare/control-plane/src/index.ts`
- Modify: `cloudflare/control-plane/README.md`

**Interfaces:**
- Consumes: `RuntimeProfile` vocabulary copied into Worker-safe validation without importing Node-only modules.
- Produces:

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

- [ ] **Step 1: Write the migration**

Use exactly additive columns so existing installations remain valid:

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

- [ ] **Step 3: Run control-plane tests and confirm failure**

```bash
pnpm control-plane:test -- fleet.test.ts
```

If the package script does not forward file arguments, run:

```bash
pnpm --filter @openmausbot/control-plane exec vitest run test/fleet.test.ts
```

Expected: FAIL because the route and migration do not exist.

- [ ] **Step 4: Implement strict presence validation**

Use a strict Zod schema:

```ts
const presenceSchema = z.strictObject({
  runtimeProfile: z.enum([
    "desktop-hub",
    "headless-hub",
    "desktop-client",
  ]),
  appVersion: z.string().trim().min(1).max(64).optional(),
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
    .max(32),
});
```

Normalize capabilities with `Array.from(new Set(values)).sort()`. Store the JSON string and update `app_version`, `last_seen_at`, `presence_updated_at`, and `updated_at` in one statement scoped to the authenticated installation ID.

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

Sort by `created_at ASC, id ASC`, matching existing installation ordering. Invalid stored `capabilities_json` must decode to `[]` rather than failing the entire account response. Invalid stored `runtime_profile` must publish `desktop-hub` and be corrected by the next valid presence update.

- [ ] **Step 6: Wire routes**

In `cloudflare/control-plane/src/index.ts`:

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

Keep `/v1/installations` unchanged for existing desktop callers except for safe optional fields added by `installationJSON()`.

- [ ] **Step 7: Run all control-plane checks**

```bash
pnpm control-plane:types
pnpm control-plane:check
pnpm control-plane:test
pnpm control-plane:dry-run
```

Expected: PASS with no remote calls.

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

Do not edit behavior in the same commit as the move.

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

Test strict decoding of this response:

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

Reject non-HTTPS endpoints, extra secret-like fields inside the installation record, malformed capability names, duplicate capabilities, unknown profiles, oversized lists, and invalid timestamps.

Verify `updatePresence()` sends `PUT`, installation bearer, exact JSON body, `redirect: error`, and no account `Origin` header.

- [ ] **Step 5: Implement safe fleet validation**

Add a validator returning only:

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

Before accepting a record, reject enumerable keys outside that allowlist. This prevents a future server regression from passing a credential-like field through native clients.

- [ ] **Step 6: Run shared and Electron client tests**

```bash
node --test shared/control-plane-client.test.mjs electron/control-plane-client.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/control-plane-client.mjs shared/control-plane-client.test.mjs electron/control-plane-client.test.mjs
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
  identity: HubIdentity;
  profile: "headless-hub";
  platform: "darwin" | "linux" | "win32";
  appVersion: string;
  displayName: string;
  secrets: HostSecretStore;
  now?: () => number;
}): {
  login(email: string, otp: string): Promise<HubAccountState>;
  register(): Promise<HubAccountState>;
  heartbeat(): Promise<void>;
  fleet(): Promise<FleetInstallation[]>;
  signOut(): Promise<void>;
};
```

- [ ] **Step 1: Write failing service tests**

Use a fake control-plane client and real temporary identity/secret stores. Test:

- login stores account token and normalized email;
- register uses `identity.id` as `clientInstanceId`;
- a valid stored installation credential is reused;
- a 401 from the self route permits account recovery;
- network/unavailable errors do not rotate or replace the stored credential;
- heartbeat sends `headless-hub`, package version, and `[
  "companion",
  "harness"
]` sorted;
- an unavailable secret store blocks registration before any network write;
- sign-out removes the account token but does not silently revoke or delete the installation;
- public returned state contains no token.

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

Never return values for keys ending in `Token`, `Credential`, or `Secret`. On any mutation, reread and validate the store before writing. An `unavailable` snapshot throws `HostSecretStoreUnavailableError` without calling the network.

- [ ] **Step 4: Write failing CLI parser tests**

Wave 1 commands are:

```text
vbotctl account request-code --email <address>
vbotctl account verify-code --email <address> --code <8-digits>
vbotctl hub register --name <display-name>
vbotctl hub heartbeat --once
vbotctl fleet list --json
vbotctl account sign-out
```

Tests must verify:

- unknown commands exit `2`;
- missing arguments exit `2`;
- `--code` is never included in error output;
- `fleet list` redacts unexpected keys ending in `token`, `credential`, `secret`, `password`, or `key` before JSON output;
- `hub heartbeat` requires `--once` in Wave 1 so this CLI does not pretend to be a service supervisor;
- success output never includes account or installation credentials.

- [ ] **Step 5: Implement the CLI with dependency injection**

The entry point should export `runVbotctl(argv, dependencies)` for tests and call it only when executed directly. Use `node:readline/promises` only for optional interactive OTP entry; command-line flags remain supported for automation, and error rendering must not echo argv.

- [ ] **Step 6: Add build and package scripts**

Create `tsconfig.runtime.build.json` matching the repository's NodeNext settings and add:

```json
{
  "scripts": {
    "build:runtime": "tsc -p tsconfig.runtime.build.json",
    "test:runtime": "vitest run runtime/src",
    "vbotctl": "node --experimental-strip-types runtime/src/cli.ts"
  }
}
```

Add `pnpm build:runtime` to `package:prepare` only after the build emits into a dedicated ignored directory and packaged smoke tests confirm no desktop artifact regression.

- [ ] **Step 7: Run runtime tests and build**

```bash
pnpm test:runtime
pnpm build:runtime
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add runtime tsconfig.runtime.build.json package.json pnpm-lock.yaml
git commit -m "feat(runtime): add headless hub account CLI"
```

---

### Task 7: Integrate stable identity and presence into Electron

**Files:**
- Modify: `electron/companion-account-service.mjs`
- Modify: `electron/companion-account-service.test.mjs`
- Modify: `electron/main.mjs`
- Add a focused Node test file if `main.mjs` wiring cannot be exercised without launching Electron.

**Interfaces:**
- Consumes: `loadOrCreateHubIdentity()`, shared control-plane `updatePresence()`.
- Preserves: every current companion account state and endpoint method.

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
- sign-out stops the timer;
- a heartbeat network failure changes no local credential or endpoint state;
- a presence 401 surfaces an account reconnect error but does not create a replacement installation automatically;
- capabilities are sorted and unique.

- [ ] **Step 2: Run the focused Electron test and confirm failure**

```bash
node --test electron/companion-account-service.test.mjs
```

Expected: FAIL on missing presence behavior.

- [ ] **Step 3: Seed hub identity from the existing Electron installation ID**

At startup, before account provisioning:

1. read secure credentials using the existing unavailable/empty/ok distinction;
2. obtain `COMPANION_CLIENT_INSTANCE_FIELD` only when the credential store is `ok`;
3. call `loadOrCreateHubIdentity({ preferredId })`;
4. if a new identity was created from no preferred ID, persist the identity ID back into the existing secure credential field;
5. if the secure credential store is unavailable, do not create a new identity from an unknown state; surface the existing credential-store error;
6. inject `hubIdentity.id` wherever the companion account service currently requests `identity.clientInstanceId`.

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

Schedule the same call every 60 seconds while signed in. The timer must be stopped during service disposal, account sign-out, and app quit.

- [ ] **Step 5: Run Electron account tests**

```bash
node --test \
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
- Modify any generated configuration typings required by the checked-in Worker workflow.

- [ ] **Step 1: Document the trust split**

State explicitly:

- account login discovers systems and owns endpoints;
- pairing still grants hub access;
- the control plane has no chats or provider secrets;
- headless secrets live in the encrypted host store;
- `hub.json` is included in hub backups and migrations;
- deleting `hub.json` creates a new hub identity and therefore is never a normal troubleshooting step.

- [ ] **Step 2: Document Wave 1 headless commands**

Include exact non-production examples:

```bash
pnpm vbotctl -- account request-code --email owner@example.com
pnpm vbotctl -- account verify-code --email owner@example.com --code 12345678
pnpm vbotctl -- hub register --name "Home V Bot"
pnpm vbotctl -- hub heartbeat --once
pnpm vbotctl -- fleet list --json
```

Do not claim a background heartbeat service exists in Wave 1.

- [ ] **Step 3: Scan for secret leakage and placeholders**

Run:

```bash
rg -n "TBD|TODO|implement later|add appropriate|handle edge cases" \
  shared server runtime cloudflare/control-plane electron docs README.md

rg -n "controlPlane(AccountToken|InstallationCredential)|omb_install_|set-auth-token" \
  runtime cloudflare/control-plane electron shared
```

Review every match. Test fixtures may use syntactically invalid redacted tokens. No production log, thrown message, snapshot, or fleet payload may include a real-shaped credential.

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
pnpm --filter @openmausbot/control-plane exec wrangler d1 migrations apply DB \
  --local --config wrangler.jsonc
```

Start the local Worker using its documented development environment, then:

1. request and verify an OTP through the test mail fixture;
2. run headless register;
3. run one heartbeat;
4. list fleet;
5. restart the CLI with the same `OMB_DATA_DIR` and confirm no second installation is created;
6. stop the Worker and confirm fleet/presence failures do not alter `hub.json` or the stored installation credential.

Do not use production credentials or endpoint provisioning in this smoke test.

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
