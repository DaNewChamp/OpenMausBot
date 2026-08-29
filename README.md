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

### What works on the phone today

- QR / manual / Tailscale / **hosted HTTPS** pairing (`openmaus.posival.com`-style routes)
- Bot and room roster, pins, unread, streaming replies over resumable SSE
- Approvals and questions, narrow “always allow” grants
- **Computer** view — live Box stream, Local VM status, idle VM screenshot preview
- Local VM lifecycle (create / stop / recreate) when the device is explicitly allowed
- On-device composer dictation (Apple speech)

Rough edges called out upstream still apply where we have not closed them: no closed-app push, voice/calls remain desktop-first, VPS SSH viewer is desktop-only.

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
