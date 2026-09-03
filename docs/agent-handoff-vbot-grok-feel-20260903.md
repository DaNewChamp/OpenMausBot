# Agent handoff: V Bot Grok-feel pass — state as of Sep 3, 2026 (evening, CDT)

Copy this file when starting a new agent on this workstream.

## Identity

- Product name: **Vi Bot** (app display name). Repo folder is `OpenMausBot` (historical); GitHub: **DaNewChamp/VBot** (private, remote `vbot-private`). Upstream fork origin: milind-soni/OpenMausBot (ignore).
- Mainline branch: **`feat/vbot-web-pairing-integration`** = live-prod Hermes lineage + QR browser pairing + everything below. `main` is stale; NEVER merge to it without Vincent.
- `feat/vbot-web-grok-desktop-chrome` (the "web branch") was fast-forwarded to the integration head; PR #3 (cursor/web-qr-pairing-approval-58de) is superseded by the integration branch.
- Local main repo: `/Users/Vincent/Github/OpenMausBot` (its checkout is dirty — do not touch it; use worktrees). Active worktrees under `/Users/Vincent/Github/.worktrees/`.

## Deployed live state (Sep 3 evening)

- **Hub**: servarica, `/opt/openmausbot/runtime/{server,companion}`, systemd `openmausbot-harness` + `openmausbot-sidecar` + `openmausbot-cloudflared`. Both `https://hub-vbot.posival.com` and `https://openmaus.posival.com` ingress to the SAME sidecar unix socket (`/var/lib/openmausbot/omb-hosted/omb-companion-origin-main/origin.sock`) — one process, one in-memory registry.
- **Web**: Oracle `/opt/docker/www/vbot` (Caddy bind mount `/opt/docker/www -> /srv/www`), `DEPLOYED_COMMIT` marker file records the build.
- **iOS**: TestFlight **83** VALID (house-style editor, provider keys, TTS read-aloud), **84** processing (live voice mode + team map web + everything). Internal group "Vi", 1 tester (Vincent). ASC app id 6805160831, renamed "Vi Bot".
- **Rollbacks on servarica**: `server-pre-housestyle-*`, `companion-pre-housestyle-*`, `server-pre-hermes-housestyle-*` (Sep 3). Restore = cp -a back + restart both services.

## What shipped today (all merged into the integration branch)

1. QR browser pairing (openmausbot://web-pair, 120s TTL, prepare→approve→redeem, one mint, secret never leaves the browser; phone approves via Settings → "Approve a browser").
2. QR encoding fix: device-name spaces were encoded "+" (URLSearchParams) and Swift read them literally — every approval bounced. Web emits %20 now; Swift decodes form-plusses from the raw query.
3. Instant approve card (scanner dismisses itself, sheet presents via onDismiss), expired-code pre-check with clear copy.
4. House style: hub-wide natural-voice instructions injected into EVERY bot prompt incl. Hermes turns (bridge + local paths); per-bot opt-out marker `[house-style: off]`; Settings → General editor (web) + iOS Settings section.
5. Narrow phone-writable config routes: `PATCH /api/config/house-style`, `PATCH /api/config/zai-key` (write-only). The broad `/api/config` writer stays computer-only — do not open it.
6. Webhooks full surface (create/rotate/test/edit/delete) + connector account disconnect allowed for paired browsers/phones. Routine-run cancel/seen allowed.
7. Web: PWA (manifest + icons + metas), pinned bots hoisted to a Pinned divider at the roster top (groups too), Team Map (network icon in sidebar header, `GET /api/team-map`), webhooks hydration on web, Vi Bot copy rename.
8. iOS: live voice mode (waveform button top-right next to the computer button → full-screen orb: idle/listening/thinking/speaking; barge-in; approvals take precedence; Live Activity toggle in Settings), TTS read-aloud per message (prepare/speak), house-style editor + provider keys (narrow routes), Hermes runtime label fix ("Model is chosen by Hermes on your computer").
9. ZAI (GLM) provider driver + catalog + Connections key row (branch `feat/vbot-zai-provider`, MERGED; default base = coding plan `https://api.z.ai/api/coding/paas/v4`; key via Settings → Connections or `ZAI_API_KEY`; `ZAI_BASE_URL` overrides).
10. Hub sidecar logs field-level web-pairing approve rejections (`[web-pair] approve reject id=…: <field> mismatch`) in `/var/log/openmausbot/sidecar.err.log`.

## TestFlight 84 verification checklist (Vincent, on device)

- Chat → waveform button top-right (next to the computer button) → orb: talk → silence ends turn → reply streams → spoken → back to listening. Barge-in mid-speech. Mute. Close mid-reply.
- Approval card arriving during voice: voice stops, card takes over, orb re-taps after.
- Dynamic Island activity (Settings toggle "voice island").
- Team map on web: sidebar network icon → hierarchy (chiefs crown members, collab edges), click-through.
- TTS speaker buttons on messages work (route fixed server-side, no app update needed).

## Known landmines

- **CI on GitHub is dead infra**: every job fails with ZERO steps executed; base branches have no runs. Local gates are the only signal: `tsc -b`, `tsc -p tsconfig.server.json`, `vitest run` (3300+ tests), `vite build`, `swift test --package-path ios`, xcodebuild app-target gate (see below).
- **`scripts/deploy-cloud-vps.mjs` is destructive** (rsync --delete over runtime incl. rollback dirs; default migrates local Mac data over /var/lib/openmausbot). Do not use. The established path: build locally, `cp -a` snapshot on servarica, rsync dist trees, restart services.
- servarica has NO repo checkout; deploys are local-build + rsync (see runbook below).
- Oracle web root on the HOST is `/opt/docker/www/vbot` (Caddy container sees `/srv/www/vbot`). No Caddyfile changes were needed; if ever needed, the Caddyfile is bind-mounted by inode — rewrite via `docker exec -i caddy sh -c 'cat > /etc/caddy/Caddyfile'`.
- Live sidecar env: `OMB_COMPANION_HOSTED_URL=https://openmaus.posival.com`, `OMB_WEB_CLIENT_ORIGINS=https://vbot.posival.com`, `OMB_DATA_DIR=/var/lib/openmausbot` (drop-in `openmausbot-sidecar.service.d/webpairing.conf` — required: the hub-identity module fails closed on the `/root/.openmausbot` symlink). Hub identity: `/var/lib/openmausbot/hub.json` (0600).
- Hermes truth lives on the mini: `~/.hermes/config.yaml` (main model = provider `zai` → `glm-5.3-flash`; MiniMax M3 + others exist in its catalog; `config.yaml.bak-zai-main-20260903` is the pre-change backup). Hermes-runtime bots ignore the V Bot model picker — iOS now says "Model is chosen by Hermes on your computer" in AgentProfileView.
- `GrokBot.ipa` in ~/Downloads is Cursor's proprietary SandMobile (co.anysphere.sand). Feature inspiration only — never extract code/assets.
- Pairing codes/tokens/keys never go in chat, logs, or screenshots. ASC API key: `~/.appstoreconnect/private_keys/AuthKey_2RY648NNC3.p8` (id 2RY648NNC3, issuer e2e0f91b-…). ASC API quirks: app rename not allowed via API; `sort` and `filter[version]` are rejected on the builds list; build `betaBuildDetails` row appears late.
- Accounts to know: servarica (`ssh servarica`), oracle (`ssh oracle`), mini = this machine. iOS device (Vincent's iPhone 17): UDID C8EA9F61-6E1A-5C41-A4DE-B3454CC89528, dev installs go THROUGH the MacBook (`rsync app to vincent@vincents.macbook.pro.lan:/tmp/OpenMausCompanion.app && xcrun devicectl device install app --device <UDID>`), or TestFlight upload via the ASC key.

## Deploy runbook (hub, from a worktree with node_modules symlinked)

```sh
./node_modules/.bin/tsc -p tsconfig.server.build.json && node scripts/bundle-server.mjs
./node_modules/.bin/tsc -p tsconfig.companion.build.json && node scripts/fix-companion-layout.mjs
ssh servarica 'ts=$(date +%Y%m%d%H%M%S); cp -a /opt/openmausbot/runtime/server /opt/openmausbot/runtime/server-pre-<label>-$ts; cp -a /opt/openmausbot/runtime/companion /opt/openmausbot/runtime/companion-pre-<label>-$ts'
rsync -az --delete dist-server/ servarica:/opt/openmausbot/runtime/server/
rsync -az --delete dist-companion/ servarica:/opt/openmausbot/runtime/companion/
ssh servarica 'systemctl restart openmausbot-harness.service openmausbot-sidecar.service'
# poll http://127.0.0.1:8799/api/health; roll back by restoring the snapshot dirs + restart
```

Web static: `vite build` → `rsync -az --delete dist/ oracle:/opt/docker/www/vbot/` → write the short commit into `DEPLOYED_COMMIT`.

iOS TestFlight: `xcodegen generate` in ios/, archive Release `generic/platform=iOS` with `DEVELOPMENT_TEAM=LT58RNRW7E CURRENT_PROJECT_VERSION=<next>` + the ASC key flags, `-exportArchive` with `ios/ExportOptions.plist` (destination upload). Next free build number: check ASC (`/v1/apps/6805160831/builds`); 83 was uploaded Sep 3 evening, 84 right after.

## Open work (ranked)

1. On-device verification of 84 (Vincent): voice loop, silence endpointing feel, barge-in, approval precedence, Dynamic Island toggle, Reduce Motion orb.
2. iOS skill library browser (assigned: grok-worker --profile alt, worktree `feat/ios-skill-library`) — sheet listing `/api/bots/:id/skills`, run via the existing CommandSkillHUDView pattern.
3. Voice call mode refinement from Vincent's feedback (84).
4. iOS webhook create/rotate UI (routes are open server-side; desktop WebhooksPanel is the reference).
5. Team library on iOS (server endpoints exist; needs new CompanionCore client methods).
6. Hermes house-style delivery is TEXT-injection per turn — acceptable; a proper session-instructions field needs bridge protocol work.
7. GitHub CI is dead (zero-step failures) — fix `.github/workflows` so PRs get signal again.
8. contracts.test.ts "exposes only a stable failure code" fails on the web freeze lineage (pre-existing) — fix on the web branch.
