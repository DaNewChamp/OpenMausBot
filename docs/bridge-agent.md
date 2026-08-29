# Bridge agent (Phase B)

A **bridge** is a lightweight daemon on a home Mac, Raspberry Pi, or small VPS.
It registers with the cloud harness and executes shell work locally — Local VM relay
and SSH forwarding come later.

```text
Cloud harness (servarica)
  ↔ HTTPS /api/bridge/*
       ↕
Bridge daemon (mini / Pi / windows)
  → local shell, future: Local VM + SSH aliases
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
node dist-bridge/index.js connect --url https://openmaus.posival.com --code 123456 --name "Mac mini"
node dist-bridge/index.js run
```

Mac install helper:

```sh
bun run deploy:bridge -- --pair
```

## API (harness)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/bridge/pairing` | loopback TCP | Start 6-digit pairing window |
| `POST /api/bridge/register` | pairing code | Mint bridge bearer token |
| `POST /api/bridge/heartbeat` | bridge bearer | Poll jobs |
| `POST /api/bridge/result` | bridge bearer | Submit job output |
| `GET /api/bridges` | loopback TCP | List registered bridges |

## Desktop viewer (Phase C)

Optional Electron/Tauri fork: pair to the cloud URL, show bot roster + transcripts +
Computer view — same role Grok Reconstructed plays locally today, but remote-first.
No SQLite on desktop; harness on VPS remains source of truth.

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
