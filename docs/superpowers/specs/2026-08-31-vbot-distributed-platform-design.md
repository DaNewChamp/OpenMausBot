# V Bot Distributed Agent Platform Design

**Date:** 2026-08-31  
**Status:** Approved direction for implementation planning  
**Base:** `vbot-private/main` at `b768f04415ecef6f7fa50744e63fb0fa8227e892`

## Product goal

V Bot becomes a self-hosted, multi-machine agent platform with one product family:

- a small headless runtime for a VPS, home server, Raspberry Pi-class host, or always-on desktop;
- a full desktop suite that can act as a hub, a remote client, and an explicitly capability-gated machine node;
- native phone clients that discover the user's systems, pair to them, and operate the same bots, conversations, approvals, providers, and computers;
- provider connections for OpenAI/Codex, Anthropic/Claude, Cursor, Grok, OpenRouter, local models, and future drivers;
- per-bot or shared execution environments, including Local VM, VPS, cloud computer, host computer, browser, and remote machine capabilities.

The target interaction resembles Grok Bot's coordinator, provider router, Box, host bridge, and multi-agent experience. V Bot keeps its own implementation, security model, product identity, and OpenMausBot attribution.

## Fixed decisions

1. **Account plus pairing is the default trust model.** Account login discovers owned V Bot systems and manages hosted endpoints. It does not grant access to bots or machines. A device still receives a hub-issued pairing credential.
2. **One hub owns a bot.** Bots, rooms, messages, provider bindings, routines, grants, and execution-target bindings live on exactly one hub. There is no cloud transcript database and no cross-hub merge in this program.
3. **The hub is the source of truth.** Phone and remote desktop clients remain thin. Machine nodes execute bounded jobs but do not become alternate bot databases.
4. **Provider credentials stay on the runtime host.** Clients receive status, model catalogs, and safe authorization prompts, never stored secrets or provider refresh tokens.
5. **Machine capabilities are opt-in and revocable.** A newly paired node advertises no execution capabilities until the owner enables them. Existing bridge approval behavior remains the minimum security bar.
6. **No wholesale Grok Reconstructed dependency.** The reconstructed repository is a behavioral and architectural reference. Native OpenMaus/V Bot drivers and contracts remain primary.
7. **Backward compatibility is mandatory.** Existing iOS pairings, hosted URL, bundle ID, bots, transcripts, bridges, provider instances, Local VM data, and release paths must continue to work during staged migration.

## Current foundation

The repository already contains the hard parts needed for this design:

- loopback-only harness with bots, rooms, transcripts, routines, provider drivers, and approvals;
- authenticated companion sidecar with a default-deny mobile allowlist and response scrubbing;
- Cloudflare control plane for email OTP, installation ownership, managed HTTPS endpoints, and credential rotation;
- headless deployment scripts for a Mac host and Linux VPS;
- a capability-gated bridge daemon with pairing, heartbeat, durable jobs, cancellation, Local VM relay, shell, and SSH forwarding;
- Electron desktop packaging and a V Bot three-column shell;
- native iOS pairing, multi-computer registry, streaming, approvals, models, Computer, Local VM, and hosted access;
- provider drivers for Codex, Claude, Cursor, Grok, OpenAI-compatible APIs, local injection, and additional ACP engines;
- existing `localVm.mode = shared | per-bot` behavior.

The gap is not another agent engine. The gap is one coherent product model across deployment, identity, provider setup, machine enrollment, execution targets, and clients.

## Core terminology

### Hub

A V Bot runtime that owns durable product state and runs agent turns. A hub can be:

- `desktop-hub`: Electron UI plus embedded harness and companion;
- `headless-hub`: service-managed harness and companion on a VPS or home server.

A stable `hubId` survives reinstall, update, hostname change, endpoint rotation, and migration. It is stored in the hub data archive.

### Client

A thin user interface paired to a hub:

- iPhone or future phone app;
- desktop suite in remote-client mode;
- local desktop renderer attached to its embedded hub.

Account login may discover a hub. Only hub pairing authorizes the client.

### Node

A machine enrolled into a hub to expose explicit capabilities. The current bridge becomes the first node implementation. A node can advertise:

- `shell`;
- `ssh-forward`;
- `local-vm`;
- `local-computer`;
- `browser`;
- future bounded capabilities.

A desktop suite may embed a node. A hub's own machine is represented as a local node without sending loopback credentials through the network.

### Provider connection

A configured provider or agent runtime available to bots. It combines:

- driver kind;
- runtime host;
- authentication method and status;
- secret references, never secret values;
- model catalog and capabilities;
- billing classification when the driver can report it.

The existing `instanceId` remains the model-routing key during migration.

### Execution target

A computer environment a bot may use. It is separate from the model provider. Examples:

- host computer on a specific node;
- Local VM on a specific node;
- managed VPS container;
- cloud Box computer;
- browser session.

An execution target declares `sharing = dedicated | shared`. Dedicated targets bind one environment to one bot. Shared targets use an explicit pool and a serialized lease so two agents cannot type into the same computer concurrently.

## Target architecture

```text
                         V Bot account control plane
                 identity · hub discovery · endpoint metadata
                      push routing · no chats or secrets
                                   │
                 account session   │   installation credential
                                   │
      ┌────────────────────────────▼────────────────────────────┐
      │                         HUB                              │
      │ harness: bots · rooms · messages · providers · targets │
      │ companion: pairing · allowlist · response scrubbing     │
      │ endpoint: LAN / Tailscale / managed HTTPS               │
      └───────────────┬──────────────────────────┬──────────────┘
                      │ paired client            │ node protocol
          ┌───────────┴────────────┐    ┌────────┴────────────────────┐
          │ iPhone / desktop client │    │ node daemon / desktop node  │
          │ account discovery       │    │ shell · VM · browser · CUA  │
          │ hub-issued device token │    │ explicit capability grants  │
          └─────────────────────────┘    └─────────────────────────────┘
```

The account control plane is not in the chat or execution path. When it is unavailable, already paired clients and nodes continue to work against the hub.

## Deployment profiles

| Profile | Processes | Durable state | Typical host |
|---|---|---|---|
| Desktop Hub | Electron, harness, companion, local node | Full hub state | Mac or Windows desktop |
| Headless Hub | harness, companion, optional tunnel | Full hub state | VPS, home server, Mac mini |
| Node Only | node daemon | node credential and local capability config | laptop, server, desktop |
| Desktop Client | Electron remote UI, optional node | paired-client token; optional node token | secondary computer |
| Hub plus Node | headless hub plus node executor | hub state plus local executor config | capable VPS or home server |

The same source tree builds every profile. Product behavior is selected by a runtime profile, not by divergent forks.

## Identity and account discovery

Each hub has a stable local identity document:

```ts
interface HubIdentity {
  schemaVersion: 1;
  id: string;
  createdAt: number;
}
```

The control plane installation record contains only safe fleet metadata:

```ts
interface FleetInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: "darwin" | "windows" | "linux";
  runtimeProfile: "desktop-hub" | "headless-hub" | "desktop-client";
  appVersion: string | null;
  capabilities: string[];
  lastSeenAt: number | null;
  endpoint: {
    url: string;
    status: "pending" | "provisioning" | "ready" | "deleting" | "error";
  } | null;
}
```

The account session lists these records. The installation credential updates only its own presence and managed endpoint. An account bearer cannot call the companion or harness.

## Pairing model

There are separate credentials for separate trust relationships:

- **Account bearer:** identifies a user to the control plane.
- **Installation credential:** lets one owned installation update its fleet metadata and endpoint.
- **Client device token:** issued by one hub after QR, six-digit code, or approved invitation; authorizes companion routes.
- **Node token:** issued by one hub after node pairing; authorizes heartbeat, job polling, result submission, and only granted capabilities.

### First client

A desktop hub shows a QR. A headless hub prints a pairing URL and six-digit code through `vbotctl pair client`. The phone may find the hub through account discovery, but still enters or scans the hub-issued challenge.

### Additional clients

An already paired owner client or local hub UI may create a short-lived invitation. Account discovery can deliver the safe hub address, but the hub still approves and issues the token.

### Nodes

A hub creates a node pairing challenge. The node presents its requested capabilities and host metadata. Registration starts with zero granted capabilities. The owner enables capabilities after enrollment.

## Provider and credential model

Provider setup must support three authentication classes without hardcoding provider-specific UI logic:

1. **CLI account session:** Codex, Claude, Cursor, and similar drivers use their official CLI authentication and snapshot probe. V Bot starts or displays the driver's declared `signInCommand`, then refreshes the provider snapshot.
2. **OAuth or device-code session:** V Bot creates a bounded authorization session and returns a safe URL/code. Tokens terminate on the hub.
3. **API key:** A trusted local UI or write-only paired-client endpoint submits a key. The key is stored on the hub and can be replaced or cleared, never read back.

A provider connection record stores metadata and secret references:

```ts
interface ProviderConnectionRecord {
  id: string;
  driverKind: string;
  displayName: string;
  runtimeHostId: "hub" | string;
  authKind: "cli-session" | "oauth" | "device-code" | "api-key" | "none";
  secretRefs: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

The first release runs provider processes on the hub. `runtimeHostId` is included now so a future node-hosted engine does not require another data migration. Node-hosted providers are not implemented until node process isolation and secret delivery have a separate reviewed design.

Desktop uses Electron `safeStorage`. Headless hosts use a versioned AES-256-GCM envelope with a separately created mode-0600 host key. This protects exported archives and prevents provider secrets from returning to `config.json`. It does not claim protection from root on the host.

Clients receive:

- connection id, label, driver kind, auth state, version, model catalog, and capability flags;
- safe setup action descriptors;
- no API key, refresh token, CLI path, environment variable, host path, or raw provider payload.

## Node and machine access model

The current bridge protocol evolves without breaking existing bridges. New node records add protocol version, platform, app version, requested capabilities, granted capabilities, and safe health details. Existing `/api/bridge/*` routes remain as compatibility aliases until all shipped clients use `/api/nodes/*`.

Every bot-to-node action resolves an exact node ID before approval. Remembered grants are scoped by:

```text
hubId + botId + nodeId + capability + program/tool + optional cwd prefix
```

Display names never grant authority. A node replacement with the same name receives a new ID and no inherited grants.

The node never receives provider credentials, account bearers, other node tokens, or unrestricted hub configuration. Jobs contain only the bounded input needed by the selected capability.

## Execution target model

The existing `BotRecord.computer` and `cloudBackend` fields remain readable during migration. A new target registry becomes authoritative after a bot receives an explicit binding:

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

Migration rules:

- `computer = off` maps to no binding;
- `computer = local` maps to a `host` target on `hub-local`;
- `computer = vm` maps to a `local-vm` target using current `localVm.mode`;
- `computer = cloud` plus `cloudBackend = box | vps` maps to the corresponding target;
- until a binding is persisted, current behavior stays authoritative.

A shared target takes a lease per interactive turn. The lease includes bot, thread, turn, target, generation, and expiry. Stale clients cannot continue controlling a target after its generation changes.

## Client experience

### First launch

1. Choose **Sign in to find my systems** or **Pair directly**.
2. Account sign-in lists owned hubs with online state and endpoint readiness.
3. Select a hub.
4. Complete hub pairing by QR, code, or an invitation approved on an existing owner client.
5. The paired hub opens the bot roster.

### Provider setup

A Providers screen groups connections by provider and runtime host. Each row shows Ready, Sign in, Needs key, CLI missing, subscription inactive, or unavailable. Model selection remains on the bot profile and chat header.

### Machines

A Machines screen lists the hub and enrolled nodes, their online state, enabled capabilities, and revocation. Capabilities are enabled individually with clear consequences.

### Bot computer

A bot profile selects an execution target and Dedicated or Shared behavior when supported. The UI never shows a target the selected provider cannot use.

## Packaging and lifecycle

The program produces:

- a headless runtime bundle with `vbotctl`;
- service installers for systemd and launchd first, then Windows Service packaging;
- a container image for hub-only VPS deployment;
- the full Electron desktop suite;
- existing iOS TestFlight builds.

`vbotctl` provides:

```text
vbotctl init --profile headless-hub
vbotctl account login
vbotctl endpoint enable
vbotctl pair client
vbotctl pair node
vbotctl provider list
vbotctl provider login <connection-id>
vbotctl provider set-key <connection-id> --stdin
vbotctl node status
vbotctl doctor
vbotctl export <archive>
vbotctl import <archive>
```

No command prints stored secrets. Diagnostics redact tokens, URLs with credentials, environment values, and private host paths.

## Persistence and migration

The hub export contains:

- stable hub identity;
- bots, groups, messages database, tasks, routines, and workspaces;
- provider connection metadata and encrypted secret store;
- companion device registry;
- node registry and grants;
- execution targets and bindings;
- a versioned manifest with checksums.

Import is offline and atomic. It checkpoints SQLite, verifies every checksum, writes into a staging directory, and swaps only after validation. Existing scripts remain until the new round-trip has passed Mac-to-VPS-to-Mac verification.

## Failure behavior

- Control plane unavailable: existing pairings and local/hosted endpoints continue; discovery and endpoint changes show unavailable.
- Hub unavailable: clients show the saved system offline; they do not switch to another hub automatically.
- Node unavailable: jobs remain queued only within their bounded deadline; running jobs reconcile through the existing generation and retry rules.
- Provider unauthenticated: the connection stays visible with a setup action; bots do not silently switch providers unless the user enabled an explicit routing policy.
- Execution target unavailable: the turn reports a setup error and leaves the bot binding unchanged.
- Secret store unavailable: the runtime reports ignorance, not an empty store, and does not overwrite credentials.

## Security invariants

1. Harness stays loopback-only.
2. Companion stays default-deny and response-scrubbed.
3. Account credentials are never accepted by companion or node routes.
4. Provider secrets never appear in fleet metadata, mobile catalogs, logs, argv, process titles, job payloads, or exports in plaintext.
5. Nodes start with zero granted capabilities.
6. Shell and host-computer actions retain approval and destructive-command holds.
7. Viewer URLs, container IDs, image IDs, loopback ports, host paths, and raw engine payloads never cross the phone boundary.
8. Revocation is immediate for future work and cancel-requests in-flight work.
9. Every persisted format is versioned and migrates forward without deleting unknown fields.
10. Production DNS, Cloudflare resources, migrations, and live hub deployment require a separate reviewed release step.

## Delivery waves

### Wave 1: Hub identity and fleet discovery

Add stable hub identity, headless secret storage, runtime profiles, control-plane presence, shared account client, and headless registration. No pairing semantics change.

### Wave 2: Account-aware clients and pairing invitations

Add optional iOS and desktop account login, fleet picker, direct-pair fallback, and hub-approved invitations. Account login alone still cannot call the hub.

### Wave 3: Provider connections and authentication

Create the provider connection registry, migrate existing instances and secrets, support CLI/OAuth/key setup, expose sanitized status to clients, and retain current model routing.

### Wave 4: Node agent v2

Evolve bridge into the general node daemon, add desktop-embedded node mode, capability management, safe node APIs, and exact per-bot/node grants.

### Wave 5: Execution targets and VM ownership

Normalize Local VM, VPS, Box, host computer, and browser into targets; add dedicated/shared bindings and leases; migrate existing bot computer fields.

### Wave 6: Distribution and product closeout

Ship unified headless installers, Docker image, desktop profile selection, account/provider/machine UI, export/import, updater path, end-to-end QA, and release documentation.

Each wave is implemented in a separate worktree and reviewed before the next begins. The master plan names the branch, tests, and exit gate for every wave.