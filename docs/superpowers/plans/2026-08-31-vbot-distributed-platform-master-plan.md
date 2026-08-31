# V Bot Distributed Agent Platform Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing V Bot/OpenMausBot fork into one coherent self-hosted product spanning headless hubs, the full desktop suite, phone clients, provider authentication, connected machine nodes, and dedicated or shared agent computers.

**Architecture:** A hub owns bots and durable state. Optional account login discovers hubs and manages hosted endpoints, while explicit hub pairing grants actual client access. Provider credentials stay on their runtime host, machine nodes expose opt-in capabilities through the existing bridge trust boundary, and execution targets normalize host, Local VM, VPS, cloud, and browser environments.

**Tech Stack:** TypeScript, Node.js 24+, Electron, React, Swift/SwiftUI, Cloudflare Workers and D1, SQLite, launchd, systemd, Docker, existing OpenMaus provider-driver and companion contracts.

**Spec:** `docs/superpowers/specs/2026-08-31-vbot-distributed-platform-design.md`

## Global Constraints

- Canonical repository is `DaNewChamp/VBot`; push only to `vbot-private`, never `origin`.
- Base every implementation wave on the latest intended `vbot-private/main`, not on the planning branch's historical base.
- Use one isolated worktree and one task-specific branch per wave.
- Preserve unfamiliar local changes and old worktrees. Never reset, stash, clean, revert, overwrite, or delete them.
- Harness remains bound to `127.0.0.1:8799`.
- Account login discovers installations but never replaces client or node pairing.
- The control plane stores no bots, chats, prompts, tool output, provider secrets, pairing tokens, node tokens, or computer viewer URLs.
- Provider credentials remain on the hub for this program. Node-hosted provider processes require a separate approved design.
- Mobile receives sanitized metadata only. Secret submission, when added, is write-only and never echoed.
- New nodes start with zero granted execution capabilities.
- Existing iOS bundle ID `com.posival.openmausmobile`, pairing protocol, data directory, hosted URL, and current user data remain compatible.
- Existing `BotRecord.computer`, `cloudBackend`, bridge routes, provider instances, and deployment scripts remain readable until their replacements pass migration and rollback tests.
- Production deploys, Cloudflare changes, App Store uploads, and DNS changes are separate explicit release actions.

---

## Program decomposition

This is not a one-branch feature. Implement six independently reviewable waves. Each wave must be merged before the next wave branches, because later interfaces depend on the accepted version of earlier work.

| Wave | Branch | Primary deliverable | Detailed plan |
|---|---|---|---|
| 1 | `feat/vbot-hub-fleet-foundation` | Stable hub identity, headless secret store, fleet presence/discovery | `docs/superpowers/plans/2026-08-31-vbot-wave-1-hub-fleet-foundation.md` |
| 2 | `feat/vbot-account-pairing-clients` | Optional account login on clients plus hub-issued pairing invitations | Create after Wave 1 merges |
| 3 | `feat/vbot-provider-connections` | Unified provider connection and authentication lifecycle | Create after Wave 2 merges |
| 4 | `feat/vbot-node-agent-v2` | General machine node protocol and desktop-embedded node | Create after Wave 3 merges |
| 5 | `feat/vbot-execution-targets` | Dedicated/shared execution targets and compatibility migration | Create after Wave 4 merges |
| 6 | `feat/vbot-distribution-closeout` | Installers, profile selection, export/import, QA, release docs | Create after Wave 5 merges |

## Standard worktree procedure

At the start of each wave:

```bash
cd /Users/Vincent/Github/OpenMausBot
git fetch vbot-private main
git worktree list --porcelain
git status --short --branch
git log --oneline --decorate -8 vbot-private/main

git worktree add \
  /Users/Vincent/Github/.worktrees/<wave-directory> \
  -b <wave-branch> \
  vbot-private/main

cd /Users/Vincent/Github/.worktrees/<wave-directory>
pnpm install --frozen-lockfile
```

Before modifying files, read `README.md`, `docs/v-bot-architecture.md`, `docs/VBOT_DESKTOP_ARCHITECTURE.md`, `docs/ios-companion.md`, `docs/bridge-agent.md`, `docs/cloud-vps-hosting.md`, this master plan, the design spec, and the wave plan.

For every wave:

```bash
pnpm typecheck
node scripts/test-floor.mjs
cd ios && swift test
```

If the baseline fails, record the exact existing failures before editing. Do not silently fix unrelated failures in the wave branch.

---

## Wave 1: Hub identity and fleet foundation

### Result

Desktop and headless hubs share a stable hub identity, encrypted host secret abstraction, runtime profile vocabulary, and control-plane fleet presence contract. Account-authenticated clients can list owned systems, but no hub pairing behavior changes.

### Interfaces produced

```ts
type RuntimeProfile = "desktop-hub" | "headless-hub" | "desktop-client";

interface HubIdentity {
  schemaVersion: 1;
  id: string;
  createdAt: number;
}

interface FleetInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: "darwin" | "windows" | "linux";
  runtimeProfile: RuntimeProfile;
  appVersion: string | null;
  capabilities: string[];
  lastSeenAt: number | null;
  online: boolean;
  endpoint: { url: string; status: string } | null;
}
```

### Exit gate

- Existing desktop account and managed endpoint tests still pass.
- A headless test runtime registers once, reuses its installation credential, heartbeats, and appears in `GET /v1/fleet`.
- Restarting the runtime preserves `hubId` and does not create a second installation.
- Deleting or corrupting the secret envelope reports unavailable and never overwrites the remote installation.
- No companion or iOS route changes.

Execute the checked-in Wave 1 plan exactly.

---

## Wave 2: Account-aware clients and pairing invitations

### Files expected

- Create: `ios/Sources/CompanionCore/AccountClient.swift`
- Create: `ios/Sources/CompanionCore/AccountSessionStore.swift`
- Create: `ios/Sources/CompanionCore/FleetDiscovery.swift`
- Create: `ios/App/AccountSignInView.swift`
- Create: `ios/App/FleetPickerView.swift`
- Modify: `ios/App/PairingView.swift`
- Modify: `ios/App/CompanionApp.swift`
- Modify: `ios/Sources/CompanionCore/ConnectionRegistry.swift`
- Create: `server/pairing-invitations.ts`
- Modify: `server/index.ts`
- Modify: `companion/src/routes.ts`
- Modify: `companion/src/proxy.ts`
- Modify: `src/components/CompanionSection.tsx`
- Create corresponding Swift, server, companion, and desktop tests.

### Required behavior

- Sign-in is optional; Pair directly remains first-class.
- Account session is stored in Keychain separately from hub device tokens.
- `GET /v1/fleet` supplies discovery metadata only.
- Selecting an unpaired hub starts a hub pairing flow and cannot fetch `/api/bots`.
- First pairing still requires a hub-displayed QR or code.
- An already paired owner device may create a two-minute invitation. The invitation is single-use, hub-scoped, attempt-limited, and invalidated when the creating device is revoked.
- A new client's account bearer is never forwarded to the companion.

### Contract

```ts
interface PairingInvitation {
  id: string;
  challenge: string;
  hubId: string;
  createdByDeviceId: string;
  expiresAt: number;
  attemptsLeft: number;
  consumedAt?: number;
}
```

The companion accepts only the invitation challenge as an alternative input to the existing pairing register operation. It still mints the normal per-device token.

### Test gate

```bash
pnpm vitest run companion/test server/pairing-invitations.test.ts
cd ios && swift test
pnpm typecheck
node scripts/test-floor.mjs
```

Simulator verification:

1. Launch with no account and pair directly.
2. Launch with account, list a ready hub, and confirm the hub remains locked before pairing.
3. Pair with a code, relaunch, and confirm the saved connection still works without control-plane availability.
4. Revoke the device and confirm fleet discovery does not restore access.

---

## Wave 3: Provider connections and authentication

### Files expected

- Create: `server/provider-connections.ts`
- Create: `server/provider-connections.test.ts`
- Create: `server/provider-auth-sessions.ts`
- Create: `server/provider-auth-sessions.test.ts`
- Create: `server/provider-secret-service.ts`
- Create: `server/provider-secret-service.test.ts`
- Modify: `server/config.ts`
- Modify: `server/registry.ts`
- Modify: `server/contracts.ts`
- Modify: `server/provider-catalog.ts`
- Modify: `server/index.ts`
- Modify: `electron/workspace-credentials.mjs`
- Modify: `electron/main.mjs`
- Create: `src/components/ProviderConnections.tsx`
- Modify: `src/components/EnginesSettings.tsx`
- Modify: `src/components/EngineSetup.tsx`
- Modify: `companion/src/routes.ts`
- Modify: `companion/src/proxy.ts`
- Create: `ios/App/ProviderConnectionsView.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift`
- Add focused tests for every modified surface.

### Interfaces produced

```ts
type ProviderAuthKind = "cli-session" | "oauth" | "device-code" | "api-key" | "none";

type ProviderConnectionStatus =
  | "ready"
  | "missing-cli"
  | "needs-auth"
  | "authorizing"
  | "invalid-credentials"
  | "inactive-subscription"
  | "unavailable";

interface ProviderConnectionRecord {
  id: string;
  driverKind: string;
  displayName: string;
  runtimeHostId: "hub";
  authKind: ProviderAuthKind;
  secretRefs: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

### Migration rules

- Existing `config.instances` rows become provider connection metadata without changing `instanceId`.
- Existing Electron workspace credentials move into the provider secret service with stable secret references.
- Existing CLI sessions remain where the official CLI stores them and are represented by `authKind = cli-session` with no copied token.
- `config.json` keeps non-secret driver configuration only.
- The current model selection `{ instanceId, model, effort? }` remains unchanged.

### Setup actions

The UI renders from driver metadata and provider status:

```ts
type ProviderSetupAction =
  | { kind: "install"; command: string; docsUrl?: string }
  | { kind: "cli-login"; command: string }
  | { kind: "open-url"; url: string; userCode?: string }
  | { kind: "submit-secret"; fields: Array<{ id: string; label: string; secret: true }> };
```

No raw secret is returned after submission. API key submission from a paired mobile client requires an owner-scoped write route, rate limit, bounded body, no logging, and a response containing status only.

### Test gate

- Provider migration is idempotent.
- Secret fields do not appear in mobile JSON, logs, command argv, snapshots, or config files.
- Codex, Claude, and Cursor existing CLI auth probes still pass.
- OpenAI-compatible key replacement takes effect without a harness restart.
- A stale provider model selection resolves through existing catalog fallback and does not switch providers silently.

Run:

```bash
pnpm vitest run server/provider-connections.test.ts server/provider-auth-sessions.test.ts server/provider-secret-service.test.ts server/provider-catalog.test.ts
node --test electron/workspace-credentials.test.mjs
cd ios && swift test
pnpm typecheck
node scripts/test-floor.mjs
```

---

## Wave 4: Node agent v2

### Files expected

- Create: `shared/node-protocol.ts`
- Create: `server/node-registry.ts`
- Create: `server/node-registry.test.ts`
- Create: `server/node-routes.ts`
- Create: `server/node-routes.test.ts`
- Create: `server/node-grants.ts`
- Create: `server/node-grants.test.ts`
- Modify: `server/bridge-registry.ts`
- Modify: `server/bridge-routes.ts`
- Modify: `server/bridge-exec.ts`
- Modify: `bridge/src/types.ts`
- Modify: `bridge/src/client.ts`
- Modify: `bridge/src/index.ts`
- Create: `electron/node-agent.mjs`
- Modify: `electron/main.mjs`
- Create: `src/components/MachinesSettings.tsx`
- Create: `ios/App/MachinesView.swift`
- Modify companion routes and tests.

### Compatibility rule

Existing bridge records and `/api/bridge/*` calls remain valid. New `/api/nodes/*` routes are the canonical API. A bridge record is read as a node with `protocolVersion = 1`; the v2 daemon advertises `protocolVersion = 2`.

### Interfaces produced

```ts
type NodeCapability =
  | "shell"
  | "ssh-forward"
  | "local-vm"
  | "local-computer"
  | "browser";

interface MachineNodeRecord {
  id: string;
  name: string;
  protocolVersion: 1 | 2;
  platform: "darwin" | "windows" | "linux";
  appVersion: string | null;
  requestedCapabilities: NodeCapability[];
  grantedCapabilities: NodeCapability[];
  createdAt: number;
  lastSeenAt: number;
  hostInfo?: string;
}
```

### Required behavior

- Registration persists requested capabilities but grants none.
- Enabling a capability is an owner operation from local UI or a paired owner device.
- Every job resolves an exact node ID before approval.
- Existing program-scoped approval keys are extended to include node ID and capability.
- A desktop suite may run an embedded node against its selected hub. Desktop node capabilities are individually disabled by default.
- Node output remains bounded and redacted. Node heartbeat and job result bodies remain size-limited.
- Provider secrets and account credentials never enter node jobs.

### Test gate

```bash
pnpm vitest run server/node-registry.test.ts server/node-routes.test.ts server/node-grants.test.ts server/bridge-*.test.ts
pnpm build:bridge
pnpm typecheck
node scripts/test-floor.mjs
cd ios && swift test
```

Live development verification uses a disposable hub data directory and a disposable node credential. Do not re-pair or modify the production Mac mini bridge during implementation.

---

## Wave 5: Execution targets and VM ownership

### Files expected

- Create: `server/execution-targets.ts`
- Create: `server/execution-targets.test.ts`
- Create: `server/execution-leases.ts`
- Create: `server/execution-leases.test.ts`
- Create: `server/execution-resolver.ts`
- Create: `server/execution-resolver.test.ts`
- Modify: `server/store.ts`
- Modify: `server/container-computer.ts`
- Modify: `server/local-computer.ts`
- Modify: `server/vps-computer.ts`
- Modify: `server/remote-computer.ts`
- Modify: `server/bridge-local-vm.ts`
- Modify: `server/index.ts`
- Modify: `companion/src/routes.ts`
- Modify: `src/components/ComputerPanel.tsx`
- Modify: `ios/App/ComputerView.swift`
- Modify related presentation-policy tests.

### Interfaces produced

```ts
type ExecutionTargetKind = "host" | "local-vm" | "vps" | "cloud" | "browser";

type ExecutionSharing =
  | { mode: "dedicated" }
  | { mode: "shared"; poolId: string };

interface ExecutionTargetRecord {
  id: string;
  name: string;
  kind: ExecutionTargetKind;
  nodeId: "hub-local" | string;
  sharing: ExecutionSharing;
  enabled: boolean;
  capabilities: string[];
  createdAt: number;
  updatedAt: number;
}

interface BotExecutionBinding {
  botId: string;
  targetId: string;
  workspaceKey: string;
}
```

### Migration and fallback

- Do not remove old `BotRecord.computer` or `cloudBackend` fields in this wave.
- `resolveExecutionTarget(bot)` first uses a persisted binding, then maps legacy fields exactly as documented in the spec.
- Persisting a new binding does not delete legacy fields until export/import and rollback tests pass.
- Existing `localVm.mode = shared | per-bot` determines the automatically created compatibility target.

### Lease contract

```ts
interface ExecutionLease {
  targetId: string;
  botId: string;
  threadId: string;
  turnId: string;
  generation: number;
  acquiredAt: number;
  expiresAt: number;
}
```

A dedicated target rejects another bot. A shared target serializes interactive control. Stop, turn completion, target recreation, timeout, and node revocation release or invalidate the lease.

### Test gate

- Every legacy computer choice resolves to the same provider and container path as before.
- Two bots cannot control one shared target concurrently.
- Recreate increments generation and rejects stale input.
- A node going offline does not silently move the bot to the hub's host computer.
- Phone responses contain no host paths, image IDs, container IDs, commands, ports, or loopback URLs.

Run focused computer tests, then:

```bash
pnpm typecheck
node scripts/test-floor.mjs
cd ios && swift test
```

Verify Local VM on an iOS simulator against a disposable local harness before any physical-device or production check.

---

## Wave 6: Distribution and product closeout

### Files expected

- Create: `runtime/src/cli.ts`
- Create: `runtime/src/doctor.ts`
- Create: `runtime/src/service-install.ts`
- Create: `runtime/src/export-import.ts`
- Create: `runtime/src/*.test.ts`
- Create: `scripts/runtime/linux/vbot-hub.service`
- Create: `scripts/runtime/linux/vbot-companion.service`
- Create: `scripts/runtime/macos/com.posival.vbot-hub.plist`
- Create: `scripts/runtime/macos/com.posival.vbot-companion.plist`
- Create: `scripts/build-headless-runtime.mjs`
- Create: `Dockerfile.headless`
- Modify: `package.json`
- Modify: Electron first-run/profile settings.
- Modify: deployment scripts to consume the common runtime bundle.
- Update README, deployment, backup, release, security, iOS, and desktop docs.

### Runtime CLI

The shipped command surface is fixed by the design spec. All commands support `--json` for machine-readable status except secret input. `provider set-key` accepts only stdin or an OS secret prompt and never a command-line value.

### Export/import

Archive manifest includes version, hub ID, paths, sizes, and SHA-256 checksums. Export checkpoints SQLite. Import writes into a staging data directory, validates all checksums and schemas, then performs one atomic swap while services are stopped. Failure preserves the original data directory.

### Release matrix

| Profile | macOS arm64 | macOS x64 | Linux x64 | Windows x64 |
|---|---:|---:|---:|---:|
| Desktop Hub | required | supported by current builder | n/a | required |
| Desktop Client | required | supported by current builder | optional | required |
| Headless Hub | required | optional | required | later unless service tests pass |
| Node Only | required | optional | required | required |
| Docker Hub | n/a | n/a | required | n/a |
| iOS Client | required | n/a | n/a | n/a |

### Final verification gate

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:build
cd ios
xcodegen generate
swift test
```

Then perform disposable end-to-end tests:

1. Start a headless hub with a fresh data directory.
2. Register it to a non-production control plane fixture.
3. Pair iOS simulator directly and through fleet discovery.
4. Configure one CLI-session provider and one API-key test provider.
5. Pair a disposable node with no capabilities; verify execution is denied.
6. Enable shell and Local VM; verify approval, cancellation, and revocation.
7. Bind two bots to dedicated targets and two bots to one shared pool; verify isolation and lease serialization.
8. Export the hub, import to a second disposable host, and reconnect the saved phone pairing.
9. Build the desktop suite and headless bundle.
10. Run `git diff --check`, inspect final status, and record exact commits.

Production deployment and TestFlight begin only after this matrix passes and the release source is reviewed.

---

## Codex execution instruction

Paste this into the local Codex session after creating the Wave 1 worktree:

```text
Implement Wave 1 from docs/superpowers/plans/2026-08-31-vbot-wave-1-hub-fleet-foundation.md.

Follow the repository and V Bot instructions. Inspect the current branch, docs, worktrees, and baseline tests first. Use test-driven development and task-sized commits. Preserve unfamiliar work. Do not deploy, change production Cloudflare resources, touch DNS, publish a desktop build, or upload TestFlight. Review every diff and run the Wave 1 verification gate before reporting completion. Report the exact branch, commits, tests, remaining risks, and any spec conflict instead of silently changing the architecture.
```
