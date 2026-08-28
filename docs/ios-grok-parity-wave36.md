# V Bot iOS — Grok parity wave 36

TestFlight / device build **36**. Native reimplementation only.

## Server + companion

- `POST /api/bots/:id/local-computer/input` — phone touch/keyboard input (click, scroll, type, key)
- `GET/WS /api/bots/:id/local-computer/viewer/*` — noVNC viewer proxy for live Local VM
- `computer_exec` agent tool — shell in Local VM container
- Companion allowlist + WebSocket upgrade forwarding for join, input, viewer routes

## iOS

- **Computer / Local VM:** `RemoteDesktopCanvas` (pinch, pan, tap, long-press right-click), `VMViewerWebView` (noVNC), keyboard sheet, `localVmJoin` / `localVmInput` / viewer session APIs
- **Chat chrome:** composer `+` uses native liquid-glass `Menu` (not bottom sheet); header transcript scrolls under floating glass with `ScrollEdgeChrome` blur fade (no opaque top bar)

## Verify

```sh
bun test server/local-vm-phone-input.test.ts server/local-vm-invoke.test.ts
cd companion && bun test test/routes.test.ts
cd ../ios && swift test
```

Redeploy hosted companion after companion changes: `bun run deploy:hosted-runtime --skip-build`
