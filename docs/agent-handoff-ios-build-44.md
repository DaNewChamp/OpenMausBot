# Agent handoff: iOS build 44 → phone install + Computer view fixes

Copy this entire file (or link it) when starting a new cloud agent on this workstream.

## Repo and branch

| Item | Value |
|------|-------|
| GitHub | [DaNewChamp/OpenMausBot](https://github.com/DaNewChamp/OpenMausBot) |
| Workspace | `/workspace` or `~/Github/OpenMausBot` on Mac |
| Branch | `cursor/build-36-local-vm-phone-a27c` |
| Base | `vincent/grok-ios-build-12` |
| PR | [#1](https://github.com/DaNewChamp/OpenMausBot/pull/1) |
| Latest work | build **44**, install script fixes (`7851b19` and later) |

## User context

- **Vincent** — prefer remote install; avoid asking him to run Terminal unless remote install is impossible.
- **iPhone 17:** `DEVICE_UDID=C8EA9F61-6E1A-5C41-A4DE-B3454CC89528`, `XCODE_DEVICE_ID=00008150-001428C00247801C`
- **Bot “Chief Keef”** — engine is **OpenMausBot** (not Grok); was on **Cloud VPS**, Local greyed out, “No screen frame arrived”.
- **Hosted companion:** `https://openmaus.posival.com` on Mac mini.
- **Mac mini MCP:** `https://local.posival.com/mcp` (OAuth via PocketID / `brain.posival.com`). Cloud-agent token in `~/.mcp-auth/mcp-remote-0.1.50/*_tokens.json`; refresh via `brain.posival.com/oauth/token` with client_id from `*_client_info.json`.
- **MacBook git remote:** `personal` (DaNewChamp fork), not `origin`.

## Orchestrator mode

You are the **orchestrator** — dispatch focused subagents (tests, deploy, install, QA); verify output; do not do all labor in one session.

### Subagent templates

| Agent | Task |
|-------|------|
| Tests | `cd ios && swift test` (355 tests on Mac mini) |
| Deploy | `bun run deploy:hosted-runtime` on Mac mini; bootstrap sidecar if exit 113 |
| Install | `./scripts/install-ios-now.sh` on mini |
| QA | Phone checklist below on physical iPhone |

## Done this session (orchestrator + subagents)

1. **Computer view UX (build 44):** idle cloud VPS waiting card; engine-specific Local VM disabled reasons; fail-open when capabilities unknown.
2. **Install scripts:** `./scripts/install-ios-now.sh` — auto-picks local Debug vs mini→MacBook WiFi path.
3. **swift test:** 355/355 pass on Mac mini.
4. **Hosted deploy:** runtime synced on Mac mini; harness + sidecar running; `/api/local-computer` 200. Sidecar may need manual `launchctl bootstrap` after deploy.
5. **Device install:** build **44** installed via `push-ios-wifi-release.sh` (mini archive → MacBook `devicectl`). MacBook SSH reachable.

## Primary open task

**Phone QA on build 44** — install succeeded; Vincent should force-quit/reopen app and verify on device.

### Correct install (preferred)

```sh
cd ~/Github/OpenMausBot
git pull personal cursor/build-36-local-vm-phone-a27c
./scripts/install-ios-now.sh
```

### Remote (agent should try first)

1. Refresh Mac mini MCP token.
2. `start_command` with `./scripts/install-ios-now.sh` from `~/Github/OpenMausBot` on the **Mac mini**.
3. Or `push-ios-wifi-release.sh` if the phone is not visible on the mini.

**MacBook:** must be **awake on Wi‑Fi** (unlock often not required if SSH works). **Will not work if the MacBook is asleep.**

**Phone:** same Wi‑Fi as MacBook; usually does not need to be unlocked for install.

See also [ios/AppStore/RELEASE.md](../ios/AppStore/RELEASE.md) (WiFi install section).

## After install — verify on phone

1. Force-quit OpenMaus Mobile, reopen (confirm build **44**).
2. Chief Keef → Computer: idle Cloud VPS = “Waiting for agent”; Local tappable in ··· menu.
3. Enable **Allow Local VM** in OpenMausBot → Settings → Companion on the Mac if Local controls are missing.

## Other open PRs / branches

| Branch | PR | Topic |
|--------|-----|--------|
| `cursor/premium-model-picker-a27c` | [#3](https://github.com/DaNewChamp/OpenMausBot/pull/3) | Model picker UX |
| `cursor/mac-mini-mcp-pr-5b0b` | [#2](https://github.com/DaNewChamp/OpenMausBot/pull/2) | Mac mini MCP connector docs |

## Backlog (lower priority)

- Merge PRs when ready
- TestFlight (90382 upload limit)
- Share extension / composer polish
- Hosted companion deploy: **done** on Mac mini for build-44 server/companion wave

## Gotchas

- Headless SSH `xcodebuild` → `errSecInternalComponent` on Share extension
- WKWebView viewer needs `omb_viewer` ticket (build 40+ companion)
- `swift test` / `bun test` not available in Linux cloud VM — run on Mac
- Cloud agent branch naming: `cursor/<name>-a27c`

## Goal for next agent

1. Dispatch **QA agent** for phone checklist (Chief Keef Computer tab, Local VM picker, idle VPS).
2. Optional: patch `deploy-hosted-runtime.mjs` to bootstrap sidecar like harness.
3. Optional: TestFlight when ASC 90382 limit clears.
4. Do not wake Vincent unless phone QA blocked by asleep MacBook or pairing issue.
