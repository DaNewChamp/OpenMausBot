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

## Phase C (implemented)

- **Bot roster + transcripts** — `GET /api/bots?messages=50` on boot; per-thread scrollback via `GET /api/threads/:threadId/messages?limit=50` when needed.
- **SSE live stream** — main process opens `GET /api/events?since=<cursor>&screens=on|off` with Bearer auth (renderer cannot use `EventSource`). Frames forward over IPC as `viewer:event`. Cursor persists in `~/.v-bot-viewer/cursor.json`; cold reconnect hydrates via `/api/bots?messages=50` when `hello.resumed === false`.
- **Streaming replies** — `runtime` frames with `content.delta` render a live tail (assistant + reasoning), cleared on `turn.completed` / settled bot text.
- **Approvals** — pending `kind=options` cards with Allow/Deny (and provider-specific labels). Answers go to `POST /api/threads/:threadId/respond`; “Always allow” uses `POST /api/bots/:id/always-allow`.
- **Computer panel** — toggle opens a third column, reconnects SSE with `screens=on`, shows latest `kind=screen` frame, and polls `GET /api/bots/:id/local-computer` for VM status.

### Manual smoke

1. Pair: `node viewer/cli.mjs pair --code …`
2. Roster: `node viewer/cli.mjs bots`
3. Open UI: `bun run viewer:open` — pick a bot, confirm transcript loads.
4. With a bot replying, confirm streaming tail appears then clears when the message settles.
5. Trigger a tool approval on the harness; confirm card shows Allow/Deny and answering updates the thread.
6. Open **Computer** — confirm local-computer status loads and live screen frames appear when the bot is using a VM.

### Tests

```sh
node --test viewer/lib/sse.test.mjs
```

## Known limitations

- Rooms/groups not shown in the sidebar (bots only).
- Computer panel is watch-only (no VNC join, keyboard, or lifecycle controls).
- No composer — read + approve only.
- SSE reconnect is best-effort (2s backoff); no offline queue.
- Screen frames are dropped when the panel is closed (`screens=off`).
