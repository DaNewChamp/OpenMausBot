# V Bot web, fleet and self-hosted voice closeout

Verified September 4, 2026, approximately 21:36 CDT. This supersedes the pre-deployment Brain checkpoint and continues `agent-handoff-native-vm-relay-20260904.md` from base `2e22fb80`.

## Deployed release

Application commit: **c8908070e7bb583ef5164e2743a069e6578838d4**.
Implementation branch/worktree: `feat/vbot-web-polish-0904` at `/Users/Vincent/Github/.worktrees/vbot-web-polish-0904`.
The handoff itself is a subsequent documentation-only commit. Check actual git/remotes rather than assuming it was already pushed.

Both production deployment markers were set to the application commit:
- Oracle web `/opt/docker/www/vbot`; public site `https://vbot.posival.com`.
- Servarica `/opt/openmausbot/runtime/{server,companion}`; public paired hub `https://hub-vbot.posival.com`.

Final web asset: `assets/index-CcF3vufo.js`.
Final index SHA-256: `36ec3ee0502d59b76fcacd779b8a69e8556dec86102df88f7c660e61d5acbb54`.
Deployed compiled SHA-256 values:

```text
server/index.js    b4da6cd56140598fe3ce177816da45b4f410f00bb1d3b2ca5db87a2f0aadb9e8
companion/routes.js 838e4db3ec0241f9cec823f03b3a2975d897918e536ba77c85af4ed646b2d56d
companion/proxy.js  da7c7134d8251f4766058b23de49d6f5e5a24b7ccb49174ce3d9ea8b40d136a4
```

All three existing services were active with zero restarts after deployment: `openmausbot-harness`, `openmausbot-sidecar`, `openmausbot-cloudflared`. Hub loopback health returned 200. Both Mac mini and Windows bridges reconnected online. This is a deployment-time observation, not a guarantee of future liveness.

## Changes shipped

`8727841e`: Computer pane is status/control; Settings owns browser setup. Restrained shell polish, machine/isolation labels, focus/reduced-motion support.

`5ea1e640`: corrected lifecycle target selection instead of always choosing the first bot. Private mode requires an actual selected bot and cannot fall back to a shared container. Missing pinned fleet machines remain unavailable instead of silently relocating. Paired Settings uses the real companion capability-safe lifecycle/status contract; host image preparation, isolation policy, capacity and deletion remain explicitly desktop-managed. Corrected mobile messages collapsing to 36 pixels because invisible reaction/action controls consumed the row. Added five-width real Chromium fixture QA.

`5d528c53`: optional Kokoro provider, direct operator endpoint or fixed request through an explicitly pinned fleet bridge. Strict paired `PATCH /api/config/voice` accepts provider/voice metadata only. Credentials stay on existing host/native paths. Bounded headers-plus-body deadlines, client-disconnect cancellation, audio/catalog caps, MIME validation, malformed/duplicate voice filtering, sanitized provider errors, and no silent cloud fallback. Existing bot voice selections are preserved; incompatible selections return an actionable 409. See `voice-self-hosted.md`.

`2147024b`: live browser QA exposed two integration defects that fixtures had not caught. Speaker now sends prepare/audio to the paired hub with its in-memory device token instead of the static Oracle origin. Added exact GET/POST `/api/bots/:id/local-computer/control` behind the existing Local VM device capability. Only take/release/dismiss-help are accepted; non-VM bots are refused, broad host control remains blocked, and the hub reuses the existing shared-resource hold logic.

`c8908070`: presentation-only guard. Bots without a VM assignment show **View only · Computer settings**, not a forbidden Take control action. Keyboard/pointer control also requires an actual available control route. The backend and companion are byte-for-byte source-identical to the fully gated `2147024b`.

## Current fleet and voice deployment

Mac mini bridge: `d029c24b-2b35-44c4-80a6-6148e350cad9`.
Windows bridge: `6b9c61f5-3517-4a59-9abe-25f3af311fef`.
Shared browser remains on Windows with `mode=shared`, `maxInstances=2`. No isolation or host assignment was silently changed.

Both bridges successfully executed a real `hostname` shell job during this session. Existing Cursor-to-Windows browser relay proof from the preceding handoff was retained. This session did not retest every provider's complete model-initiated command lifecycle.

The only explicitly VM-assigned bot at verification was store name Chief Keef, displayed as Chief of Staff, id `94a201dd-537d-40be-8da3-e723532c982b`. Displayed role aliases differ from raw store names. Do not misdiagnose that as a bot-id mismatch. All 15 bots were idle during service swaps; none had a per-bot voice override.

New hub-only systemd drop-in `/etc/systemd/system/openmausbot-harness.service.d/90-vbot-kokoro.conf`:

```ini
[Service]
Environment=OMB_KOKORO_BRIDGE_ID=6b9c61f5-3517-4a59-9abe-25f3af311fef
Environment=OMB_KOKORO_CONTAINER=kokoro-tts
Environment=OMB_KOKORO_DOCKER_CLI=docker.exe
```

Workspace TTS provider/voice are `kokoro` / `af_heart`, saved through the narrow metadata route. No new port, tunnel, public listener, model installation, or shell grant was created. The healthy existing Kokoro container is in Windows Docker Desktop. Plain `docker` in the bridge's Bash shell refers to a different WSL engine; speech intentionally uses the fixed operator enum `docker.exe`. Do not change the global Docker context or other containers. Windows host localhost:8880 is an unrelated broken service, not this healthy container. Kokoro itself is reachable internally within its existing container.

## Verification evidence

Full combined release gate at `2147024b`: **3,631 passed, 19 skipped**, 346 passing test files; 3650 registered. Suite duration 484.49 seconds. Managed job `20260905T021508-command-9100587c` completed exit 0, with frontend/server/bridge/companion typechecks, server/companion/web builds, five-width Chromium QA, real isolated voice HTTP smoke, 34 Electron checks, and packaged-server smoke all passing.

After the presentation-only `c8908070` delta: **601 frontend tests passed** across 94 files, frontend typecheck/build and all five viewport checks passed again. Backend/companion source identity to `2147024b` was independently checked. Do not say a new full suite was rerun after this last frontend-only change.

Logs on Mac:
- `/tmp/vbot-final-release-tests-0904.log`
- `/tmp/vbot-final-ui-affordance-0904.log`
- `/tmp/vbot-final-server-build-0904.log`
- `/tmp/vbot-final-web-build-0904.log`
- `/tmp/vbot-final-visual-0904.log`
- `/tmp/vbot-final-voice-http-0904.log`
- `/tmp/vbot-final-electron-0904.log`
- `/tmp/vbot-final-packaged-0904.log`

The tracked `scripts/qa-web-ui.mjs` checks widths 1440, 1024, 768, 390 and 320, no horizontal overflow, usable long-message width, correct Settings bot selection and no uncaught browser errors. It uses frozen local fixtures, not production pairing. `scripts/smoke-voice.mjs` launches a disposable real harness and verifies metadata/credential boundaries, catalog/audio bytes, rejection of arbitrary URL/key/query/JSONP input, incompatible voices and oversized text.

Independent safe inline-code AGY reviews of voice and the paired-control hotfix both reported no blocking findings. Logs: `/tmp/vbot-voice-inline-review-0904.log` and `/tmp/vbot-client-inline-review-0904.log`. An earlier Grok read-only review never started because its sandbox could not resolve a Docker socket symlink; this was not bypassed and is not counted as a completed review.

### Actual production proof, distinct from fixture tests

The final web asset loaded in a real paired browser. On the assigned VM bot, scoped control GET returned 200, take returned 200/held=true, and release returned 200/held=false. The hold was confirmed released afterward. The same scoped route on the unassigned Hermes bot returned 403. View-only UI rendered for that unassigned bot. Existing device tokens were used only in-page and never printed or copied into logs. Unauthenticated public config returned 401 in the first deployment stage.

The final release's production TTS API returned 68 voices and generated neutral MP3 speech through the Windows bridge:
- `audio/mpeg`, **66,092 bytes**, **6.12 seconds** measured request time.
- SHA-256 `a5a7ac0119d41b02ef3555e6a3847caa43d77d0efb8c3cb57a871fab509ff39a`.
- Servarica `/tmp/vbot-final-live-speech-0904.{mp3,json}`.

An earlier paired-browser GET of voice catalog/config returned 200 and 68 voices. The actual Speaker class's paired fetch behavior is tested. A final physical audio playback/microphone call was not tested. Concurrent browser work on GenStudio repeatedly changed/closed shared tabs; no GenStudio files, services, or browser state were intentionally modified.

## Honest remaining boundaries

This is a shipped web/fleet/voice-backend closeout, not completion of every distributed-platform roadmap item.

- Installed desktop `/Applications/OpenMausBot.app` is version 0.1.37. It was not rebuilt/replaced; no new DMG, iOS build or TestFlight upload occurred. The remote-first Electron client role is still separate work from the existing full desktop hub.
- Native macOS/iOS voice-call code exists and uses the shared TTS backend. Browser microphone calling is not implemented by these commits. Speech synthesis/read-aloud is not a microphone call. Actual device microphone-to-model-to-speaker behavior still needs physical-device acceptance testing.
- Shared/per-bot modes are Chromium containers with shared or separate durable profiles/workspaces, not a promise of hardware-VM isolation. Shared remains the deployed configuration. Per-bot deployment was not switched on in production.
- Speech provider and language-model provider are independent. Self-hosted Kokoro does not make a cloud language model local or change that provider's policies. The measured bridge speech latency was about six seconds for a short sentence, not proof of low-latency conversational streaming.
- Bridge lifecycle/on-login packaging and a consolidated remote-first desktop distribution remain separate roadmap areas. Do not claim every fleet OS installer or every language-model engine was smoke-tested here.

## Restart and rollback

The cloudflared unit has `PartOf=openmausbot-sidecar.service`. Stopping the sidecar stops the existing tunnel; starting only the sidecar does not restore it. For future swaps stop all three using `--no-block`, poll to inactive, atomically install verified directories, then start **all three**. A synchronous 20-second stop initially timed out during normal dependency shutdown; no forced kill or bypass was needed. Wait for real hub health after start.

Original rollback: Servarica `/opt/openmausbot/releases/vbot-web-voice-20260905T0157Z/{server,companion,config.json,pre-deploy.sha256}`; directory 0700/config 0600. Oracle `/opt/docker/www/vbot-pre-web-voice-20260905T0157Z`.

Working pre-hotfix rollback: Servarica `/opt/openmausbot/releases/vbot-client-routing-20260905T0219Z/{server,companion,pre-deploy.sha256}` and retained runtime `server-pre-client-routing-20260905T0219Z` / `companion-pre-client-routing-20260905T0219Z`. This is the working Kokoro-enabled 5d528c53 runtime. Its configuration can remain. A rollback all the way to the original runtime also needs its saved config and removal of this task's new Kokoro drop-in. Never overwrite unrelated config changes blindly.

Root `/Users/Vincent/Github/OpenMausBot` retains unrelated dirty docs/package/build/peekaboo changes, untouched. Never reset, clean or stash it. The standalone voice clone's origin points to that local repo, not GitHub. Push feature refs only to Vincent's `personal` and `vbot-private` remotes; no main/upstream push.
