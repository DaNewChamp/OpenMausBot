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

## Done this session

1. **Computer view UX (build 44):** idle cloud VPS shows “Waiting for agent” instead of stale timeout; `streamLoadFailure` ignores watch errors when idle; Local menu fails open when engine unknown; engine-specific disabled reasons.
2. **Install scripts:** `./scripts/install-ios-now.sh` — MacBook = local Debug install; Mac mini = `push-ios-wifi-release.sh` (sign on mini, `devicectl` on MacBook). **Do not SSH `xcodebuild` to the MacBook** — Share appex codesign fails headlessly.
3. Pushed to `cursor/build-36-local-vm-phone-a27c`; PR #1 updated.

## Primary open task

**Install build 44 to Vincent’s phone.** Not successfully installed yet.

Last failure: old `install-ios-via-macbook-hop.sh` path → CodeSign failed on `OpenMausCompanionShare.appex` over SSH; fallback SSH to `192.168.112.99` permission denied.

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
- Hosted companion redeploy if server changes land: `bun run deploy:hosted-runtime`

## Gotchas

- Headless SSH `xcodebuild` → `errSecInternalComponent` on Share extension
- WKWebView viewer needs `omb_viewer` ticket (build 40+ companion)
- `swift test` / `bun test` not available in Linux cloud VM — run on Mac
- Cloud agent branch naming: `cursor/<name>-a27c`

## Goal for next agent

1. Re-auth Mac mini MCP if needed.
2. Run `./scripts/install-ios-now.sh` on Mac mini (or MacBook if phone is paired there and MCP can reach it).
3. Confirm build 44 on device; report success or paste the last 30 lines of failure.
4. Do not make Vincent get out of bed unless the MacBook is asleep and install is impossible remotely.
