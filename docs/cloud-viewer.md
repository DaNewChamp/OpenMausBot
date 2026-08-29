# V Bot Cloud Viewer

Thin desktop client for the **cloud harness** — no local SQLite, no harness on your Mac.

```text
Electron viewer  →  https://openmaus.posival.com  →  companion  →  harness
```

Same pairing model as the phone: six-digit code from the cloud sidecar control plane.

## Pair

```sh
# Opens pairing on servarica and saves ~/.v-bot-viewer/credentials.json
node scripts/pair-cloud-viewer.mjs "Vincent's MacBook"

# Or manually:
ssh servarica 'curl -s -X POST http://127.0.0.1:28811/pairing'
node viewer/cli.mjs pair --code 123456 --name "V Bot Viewer"
```

## Run

```sh
node viewer/cli.mjs bots     # CLI roster check
node viewer/cli.mjs open     # Electron window
bun run viewer:open          # same
```

Phase C adds Computer view, streaming replies, and approvals — this slice is roster + transcript read.
