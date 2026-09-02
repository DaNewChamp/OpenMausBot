<div align="center">

# V Bot · OpenMausBot (iOS fork)

**Grok Bot–style agents on your phone — backed by your Mac.**

<sub>A fork of [OpenMausBot](https://github.com/milind-soni/OpenMausBot) focused on the native iOS companion, hosted pairing, and the phone-first workflows we actually use day to day.</sub>

![Swift](https://img.shields.io/badge/Swift-SwiftUI-F05138?logo=swift&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-harness-3178C6?logo=typescript&logoColor=white)
![iOS](https://img.shields.io/badge/iOS-companion-000000?logo=apple&logoColor=white)

<br>

**Bundle ID:** `com.posival.openmausmobile` · **TestFlight:** internal builds from `ios/`

</div>

---

## About this fork

This repository tracks **[DaNewChamp/OpenMausBot](https://github.com/DaNewChamp/OpenMausBot)** — an **iOS-focused pass** on Milind Soni's upstream [OpenMausBot](https://github.com/milind-soni/OpenMausBot).

We keep the full upstream tree (desktop app, harness, companion sidecar, server) because the phone is not a standalone product: it is a **thin client** to the harness on your Mac. This fork's active work is:

- **`ios/`** — V Bot, the native SwiftUI companion (Grok Bot–aligned home, chat, Computer, approvals)
- **`companion/`** — the sidecar the phone talks to (allowlist, pairing, SSE scrubbing)
- **`server/`** — harness changes the phone needs (Local VM lifecycle, screenshot while idle, container image layers)
- **Hosted runtime** — headless harness + sidecar on a home Mac (`scripts/deploy-hosted-runtime.mjs`), no desktop app required for daily phone use

Upstream desktop releases, Polar support links, and the original product positioning live on [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot). When something here is generally useful, the intent is to upstream it.

> **No affiliation with any cryptocurrency.** OpenMausBot has no token. Any coin using the OpenMausBot, Maus, or SupaMaus name is not created, endorsed, or affiliated with the upstream project or its maintainer.

---

## How V Bot fits

Your **Mac owns everything**: bots, rooms, transcripts, credentials, SQLite data, agent processes, and computers. The iPhone owns **pairing trust** (Keychain) and a live view of that harness while connected.

```text
 iPhone (V Bot)
       │  LAN / Tailscale / hosted HTTPS
       ▼
 companion sidecar (:8810 / hosted route)
       │  loopback only
       ▼
 harness server (127.0.0.1:8799)
       │
       ▼
 ~/.openmausbot  —  bots, messages, config, VM workspaces
```

There is **no cloud sync** between two databases. When you send a message, approve a tool, or change a bot setting on the phone, it hits the Mac harness immediately. If the Mac is asleep or the harness is down, the app cannot read or write.

Deep architecture: [`docs/ios-companion.md`](docs/ios-companion.md) · iOS layout and build: [`ios/README.md`](ios/README.md)

### Account, pairing, and host trust

V Bot keeps account discovery separate from access to a hub:

- **Account login** discovers systems and owns control-plane endpoints. It does
  not grant access to bots, chats, computers, or provider credentials.
- **Hub pairing** still grants client access. A QR code, pairing code, or
  owner-approved invitation issues the hub's device credential.
- The account control plane has no chats, transcripts, SQLite state, provider
  secrets, or execution payloads. Raw provider secrets, account bearer values,
  installation credential values, and connector tokens are not stored in D1;
  Better Auth still persists session records and hashed OTP values, while
  installation rows retain credential metadata and SHA-256 digests. It
  publishes only safe fleet metadata.
- Provider and headless account secrets stay on the host: Electron uses the
  operating system's `safeStorage`, while headless hubs use the encrypted
  `host-secret.key` + `host-secrets.bin` store.

Each runtime has one canonical data directory. Electron resolves its existing
compatibility path first, then uses the final `app.getPath("userData")` for
`hub.json`, desktop credentials, and runtime state. A headless runtime must be
given an explicit absolute `--data-dir`. `OMB_DATA_DIR` remains a legacy,
explicit override for existing server and Electron consumers; it is not an
implicit default for new headless commands. `vbotctl` never reads that
environment variable: its injected fixture passes the temporary path directly
through `--data-dir`. `hub.json`,
`host-secret.key`, and `host-secrets.bin` are part of a headless hub backup or
migration; an Electron archive includes `hub.json` and its OS-encrypted
credential file under the final `app.getPath("userData")`. On POSIX hosts the
runtime requires the directory and files to remain owner-controlled with
private modes; Windows has no reliable POSIX uid/mode bits, so it retains the
symlink, regular-file, and read-error checks while relying on the OS ACL for
access control.

Presence has an explicit lifecycle. Sign-out calls `stopPresence()`, and app
quit calls `dispose()` so no heartbeat survives teardown. `Node Only` and
`Hub plus Node` are deployment compositions planned for Wave 4, not Wave 1
runtime roles. Deleting `hub.json` creates a new hub identity; it is never a
normal troubleshooting step and can strand the existing installation.

## Wave 1 headless commands

The Wave 1 CLI is intentionally small and one-shot. It does not run a
background heartbeat service. `--data-dir` is required on every command and
must be absolute:

```sh
pnpm run vbotctl -- --data-dir /var/lib/vbot account request-code --email owner@example.com
pnpm run vbotctl -- --data-dir /var/lib/vbot account verify-code --email owner@example.com
pnpm run vbotctl -- --data-dir /var/lib/vbot hub register --name "Home V Bot"
pnpm run vbotctl -- --data-dir /var/lib/vbot hub heartbeat --once
pnpm run vbotctl -- --data-dir /var/lib/vbot fleet list --json
```

The verification code is entered through a hidden TTY prompt. For a
non-interactive local test, pipe only the short-lived code through stdin and
pass the fixture's temporary path explicitly with `--data-dir`:

```sh
printf '%s\n' '12345678' | \
  pnpm run vbotctl -- --data-dir /tmp/vbot-local-fixture account verify-code \
  --email owner@example.com --stdin
```

The CLI never accepts a verification code, bearer, or installation credential
as an argument and redacts credential-shaped output. A usage error exits `2`,
an operational failure exits `1`, and a successful command exits `0`.

The automated local route/CLI smoke is
`pnpm --filter @openmausbot/control-plane exec vitest run test/vbotctl-local-smoke.test.ts`.
It keeps the Worker, D1, mail capture, and headless service in the test-only
Workers pool and uses the explicit `http://127.0.0.1` client origin; it does
not contact a deployed control plane.

### What works on the phone today

- QR / manual / Tailscale / **hosted HTTPS** pairing (`openmaus.posival.com`-style routes)
- Bot and room roster, pins, unread, streaming replies over resumable SSE
- Approvals and questions, narrow “always allow” grants
- **Computer** view — live Box stream, Local VM status, idle VM screenshot preview
- Local VM lifecycle (create / stop / recreate) when the device is explicitly allowed
- On-device composer dictation (Apple speech)
- First-party Hermes profile connection from **Settings → Integrations → Hermes**

Voice calls are not shipped yet. The approved foreground, half-duplex iPhone
design (1:1 and team calls, on-device speech, existing chat/SSE/TTS, and
tap-to-interrupt) is tracked in
[`docs/superpowers/plans/2026-09-01-vbot-native-voice-calls.md`](docs/superpowers/plans/2026-09-01-vbot-native-voice-calls.md).
Closed-app push and the VPS SSH viewer remain separate follow-ons.

### Connect Hermes

Hermes runs where its account and installation already live; V Bot provides the
pairing, conversation, approvals, and UI:

1. Start the V Bot hub and companion on the computer where Hermes is installed
   and signed in.
2. Pair that computer to the iPhone using the normal QR flow (**Settings →
   Phone** on desktop, then **Connect my computer** on iPhone).
3. On the iPhone, open **Settings → Integrations → Hermes** and tap **Connect
   Hermes**. Choose a profile only when multiple profiles are available.
4. V Bot opens the profile's canonical **Bot Chat** as a normal V Bot bot.

For Hermes on another machine, pair that V Bot computer separately and repeat
the flow while it is selected. Account login discovers a hub but never replaces
device pairing. Bridges currently expose only `shell`, `local-vm`, and
`ssh-forward`; remote Hermes-over-bridge streaming is not implemented and must
not be faked with a shell job. See [`docs/hermes-adapter.md`](docs/hermes-adapter.md)
and [`docs/bridge-agent.md`](docs/bridge-agent.md) for the boundary and future
dedicated-transport requirements.

---

## Running the hosted stack (no desktop app)

On the Mac that should answer the phone (e.g. a always-on Mac mini):

```sh
git clone https://github.com/DaNewChamp/OpenMausBot.git && cd OpenMausBot
bun install   # or pnpm install

# Build + deploy headless harness, companion, and VM image prep
bun run deploy:hosted-runtime

# After bumping IMAGE_LAYER_VERSION in server/container-computer.ts:
bun run deploy:hosted-runtime --pull-vm

# Recreate the Local VM from the current image (e.g. after Chrome layer update):
bun run deploy:hosted-runtime --recreate-vm
```

This installs:

| Service | Role |
|---|---|
| `com.posival.openmaus-harness` | Harness on `127.0.0.1:8799` — bots, turns, Docker Local VM |
| `com.posival.openmaus-hosted-sidecar` | Phone-facing sidecar + hosted tunnel endpoint |

Runtime files: `~/Library/Application Support/OpenMausBotHostedCompanion/runtime/`  
Logs: `~/Library/Logs/OpenMausBotHostedCompanion/`

The Electron desktop app is optional for this path; pairing control plane and hosted URL wiring are documented in [`docs/ios-companion.md`](docs/ios-companion.md).

---

## Building V Bot (iOS)

```sh
cd ios
xcodegen generate          # if project.yml changed
open OpenMausCompanion.xcodeproj

# Core library tests (no device):
swift test
```

App target: **OpenMausCompanion** · see [`ios/README.md`](ios/README.md) and [`ios/TESTING.md`](ios/TESTING.md) for device install and TestFlight notes. When TestFlight upload is blocked, use [`ios/AppStore/RELEASE.md`](ios/AppStore/RELEASE.md#wifi-install-when-testflight-is-unavailable) or `./scripts/push-ios-wifi-release.sh`.

Pair against a running harness + sidecar:

```sh
# Dev: two terminals on the Mac
bun run dev:server         # harness → 127.0.0.1:8799
bun run companion          # sidecar → :8810, pair at :8811
```

---

## Repository map (fork touchpoints)

| Path | What |
|---|---|
| `ios/` | V Bot — SwiftUI app + `CompanionCore` |
| `companion/` | Sidecar the phone is allowed to call |
| `server/` | Harness API, drivers, Local VM / container image |
| `scripts/deploy-hosted-runtime.mjs` | Headless deploy to a home Mac |
| `scripts/deploy-cloud-vps.mjs` | Headless deploy to a Linux VPS (cloud-first phone stack) |
| `scripts/hosted-runtime/` | launchd plist + `start-harness.sh` |
| `electron/`, `src/` | Upstream desktop app (maintained for parity, not the focus here) |

---

## Upstream desktop (reference)

OpenMausBot upstream ships signed macOS, Windows, and Ubuntu builds with an embedded harness. If you want the full desktop experience or to compare behavior:

- **Upstream repo:** [github.com/milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)
- **Releases:** [openmausbot-releases](https://github.com/milind-soni/openmausbot-releases/releases)

From source (upstream-style):

```sh
pnpm install
pnpm dev:server    # harness → 127.0.0.1:8799
pnpm dev           # web UI → http://127.0.0.1:5199
pnpm dev:desktop   # Electron shell
```

Requirements: Node 24+, pnpm (or bun for scripts), and at least one local agent CLI (`claude`, `codex`, or `grok`).

---

## Status

**Active fork work:** iOS companion parity with Grok Bot UX patterns, hosted pairing, Local VM phone controls, headless home-server deploy, container image layers (including Chrome in the Local VM).

**Upstream baseline:** v0.1.37-era tree; desktop releases and capability matrix described on [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot).

Contributions welcome on the iOS and companion surfaces. Driver SPI and harness contracts remain as documented upstream in [`server/contracts.ts`](server/contracts.ts).

---

## License

[Apache License 2.0](LICENSE) © 2026 Milind Soni and OpenMausBot contributors.

This fork adds Posival/DaNewChamp iOS and hosted-runtime work on top of that baseline. Packaged Cua Driver components retain upstream MIT/SIL/OFL/MPL terms; see [`third_party/cua-driver/`](third_party/cua-driver/).

OpenMausBot is an independent, open-source project inspired by Grok Bot. It is not affiliated with, endorsed by, or associated with xAI; "Grok" is a trademark of its respective owner.
