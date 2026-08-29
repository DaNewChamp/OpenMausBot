# Bridge agent (Phase B+)

A **bridge** is a lightweight daemon on a home Mac, Raspberry Pi, or small VPS.
It registers with the cloud harness and executes work locally: shell commands,
Local VM relay, and SSH aliases from the bridge host's `~/.ssh/config`.

```text
Cloud harness (servarica)
  ↔ HTTPS /api/bridge/*
       ↕
Bridge daemon (mini / Pi / windows)
  → local shell, Local VM docker, SSH aliases
```

Phones still talk only to the companion sidecar. Bridges use their own bearer tokens.

## Pair a bridge

On the **cloud harness host** (loopback only):

```sh
ssh servarica 'curl -s -X POST http://127.0.0.1:8799/api/bridge/pairing'
# → { "code": "123456", "expiresIn": 120 }
```

On the **bridge machine**:

```sh
bun run build:bridge
OMB_BRIDGE_LOCAL_VM=1 node dist-bridge/index.js connect --url https://openmaus.posival.com --code 123456 --name "Mac mini"
OMB_BRIDGE_LOCAL_VM=1 node dist-bridge/index.js run
```

Mac install helper:

```sh
OMB_BRIDGE_LOCAL_VM=1 bun run deploy:bridge -- --pair
```

## Capabilities

| Env | Bridge advertises | Used for |
|---|---|---|
| _(default)_ | _(none)_ | Pairing only; execution capabilities are opt-in |
| `OMB_BRIDGE_SHELL=1` | `shell` | `run_on_bridge`, loopback `/api/bridges/:id/shell` |
| `OMB_BRIDGE_LOCAL_VM=1` | `local-vm` | Relay `GET/POST /api/bots/:id/local-computer*` when harness has no local docker |
| `OMB_BRIDGE_SSH_FORWARD=1` | `ssh-forward` | `run_on_ssh_target`, `/api/internal/bridge/ssh` |
| `OMB_BRIDGE_PEEKABOO=1` | `peekaboo` | `observe_bridge_screen` (CLI `see` / `image` only — never click or type) |

Capabilities advertised at **pair** time become `grantedCapabilities`. Later heartbeats may drop a cap (daemon flag off) but **cannot widen** the grant. Re-pair to add Peekaboo, shell, Local VM, or SSH forward.

Shell, SSH, and Peekaboo agent tools wait on an **owner-thread-bound** approval card (`server/bridge-approval.ts`). Auto mode does not inherit. Always-allow uses `scope: "bridge"` keys such as `bridge:run_on_bridge:<program>`.

On the **harness**, set `OMB_LOCAL_VM_RELAY=1` to always relay Local VM API calls
through a bridge (even when the VPS itself has docker). Otherwise relay activates
automatically when the harness has no healthy local container runtime but an
online bridge advertises `local-vm`.

## Local VM relay

When relay is active, companion and desktop Local VM routes hit the bridge instead
of local docker on the harness host:

- `GET /api/bots/:id/local-computer` → `local-vm-status`
- `POST …/local-computer/(run|stop|recreate)` → `local-vm-action`
- `POST …/local-computer/screenshot` → `local-vm-screenshot`

The bridge uses the same per-bot container naming as the harness
(`openmausbot-computer-<digest>`). Create/recreate **pulls** `OMB_BRIDGE_VM_BASE_IMAGE`
(or `OMB_BRIDGE_VM_IMAGE`) when the image is absent. Jobs honor `AbortSignal` so a
cancel-request stops an in-flight pull/create. Live “phone creates VM on mini when
the image is missing” still needs the Mac mini Docker/Podman host.

Chief can also use the existing bot local-computer API from agents; no separate
`run_on_bridge` VM tool is required when those routes are relayed.

## Named SSH targets

Add aliases to harness config (`~/.openmausbot/config.json` on the VPS):

```json
{
  "bridgeSshTargets": {
    "windows": { "bridge": "Mac mini", "alias": "windows" },
    "servarica": { "alias": "servarica" }
  }
}
```

- `alias` — SSH config alias on the **bridge** host
- `bridge` — optional bridge display name; omit to use the freshest `ssh-forward` bridge

Agents tool: `run_on_ssh_target(command, target, bridge?)`

Loopback harness route: `POST /api/internal/bridge/ssh` with `{ target, command, bridge? }`.

## API (harness)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/bridge/pairing` | harness-host loopback TCP (not companion) | Start 6-digit pairing window |
| `POST /api/bridge/register` | pairing code (public tunnel) | Mint bridge bearer token |
| `POST /api/bridge/heartbeat` | bridge bearer (public tunnel) | Poll jobs |
| `POST /api/bridge/result` | bridge bearer (public tunnel) | Submit job output |
| `GET /api/bridges` | harness-host loopback **or** paired companion | Scrubbed roster (no token hashes) |
| `DELETE /api/bridges/:id` | harness-host loopback **or** paired companion | Revoke; in-flight jobs are cancel-requested |
| `POST /api/bridges/:id/rotate` | harness-host loopback **or** paired companion | Heartbeat carries `nextToken` during overlap |
| `GET /api/bridge/jobs` | harness-host loopback TCP (not companion) | Audit durable job records |
| `GET /api/bridge/jobs/:id` | harness-host loopback TCP (not companion) | Inspect one job |
| `POST /api/bridge/jobs/:id` `{ "action": "cancel" }` | harness-host loopback TCP (not companion) | Cancel queued immediately; **running** stays `running` until abort/result |

Companion daemon allowlist remains exactly register / heartbeat / result. Paired phones may list, revoke, and rotate. Job audit, pairing, and loopback shell stay harness-host-only even when the sidecar hop would otherwise look local.

Cancel of a **running** job is not ledger-only: the heartbeat returns `cancelJobIds` and the daemon aborts the child (`AbortSignal`). A corrupt `bridge-jobs.json` is copied to `bridge-jobs.json.corrupt-*` and `.quarantined` rather than parsed as an empty map. Each worker presents a `workerId`; a second daemon cannot steal a leased running job until that worker goes stale (~30s).

## Desktop viewer (Phase 4)

Paired Electron viewer (`viewer/`): roster, rooms, composer, interrupt, approval cards, model switch, Local VM actions, and bridge list/revoke/rotate. No SQLite on desktop; the hub remains source of truth. Live daily-driver verification against Servarica is still a human gate.

Chief can run shell on a registered bridge via `run_on_bridge` (agents tool) or loopback:

```sh
ssh servarica 'curl -s -X POST http://127.0.0.1:8799/api/bridges/<id>/shell \
  -H "Content-Type: application/json" \
  -d "{\"command\":\"hostname\"}"'
```

Similar **shape** (central agent + execution backends + messenger gateway), different **product**:

| | Hermes | V Bot / OpenMausBot cloud |
|---|---|---|
| Core loop | Single `AIAgent` conversation loop | Multi-bot harness + Chief delegation |
| Mobile | Telegram/Discord gateways | Native iOS companion + scrubbed sidecar |
| Execution | Pluggable backends (Docker, SSH, Modal…) | VPS Docker + home bridges |
| Memory/skills | Built-in learning loop, SOUL.md | Per-bot workspaces + Brain/external |
| Your fork | Upstream OSS | Vincent's bots, pairing, hosted stack |

You're building **hosted multi-bot ops with a phone-first client**, not cloning Hermes's
self-improving single-agent OS. Overlap is "agent with remote execution" — that's table stakes now.
