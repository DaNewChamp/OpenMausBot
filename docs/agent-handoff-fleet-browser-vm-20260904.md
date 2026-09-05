# Agent handoff: fleet lightweight Chromium Local VM — 2026-09-04 1:01pm CDT

Copy this file when starting a new agent on this workstream. Grok (alt) shipped the browser-VM path; next agent is Claude picking up after Vincent tests Deploy.

## Identity

- Product: **Vi Bot** / V Bot. Repo folder `OpenMausBot`. GitHub: **DaNewChamp/OpenMausBot** (remote `personal`). Private: **DaNewChamp/VBot** (`vbot-private`). Upstream `origin` is milind-soni/OpenMausBot — **do not push origin**.
- Active worktree: `/Users/Vincent/Github/.worktrees/fleet-models-ui` on **Mac mini** (`Vincents-Mac-mini.local`). Main checkout `~/Github/OpenMausBot` is dirty — do not touch it; use worktrees.
- Branch: **`feat/fleet-models-ui`**. HEAD **`4bf2d2d2`** `feat(fleet): lightweight headless Chromium Local VM with CDP takeover`. Working tree clean. Pushed `personal feat/fleet-models-ui`.
- Hard constraints: **do not merge**, **do not TestFlight**, **do not use `scripts/deploy-cloud-vps.mjs`**. Ask before adding bun. Times in America/Chicago.

## Product rules (still in force)

- Bots stay hub-centric on Servarica. Computer/VM is the assignment axis. One fleet VM location for every bot. Computer pane is that VM only (Cloud / Linux VM / This host picker is gone).
- Fleet Local VM default is a **lightweight headless Chromium+CLI container**, not Cua XFCE. Cua XFCE remains for **BYO-VPS only**.
- No Cua-on-Windows product path beyond using Docker there as a Linux VM host.
- Isolation PATCH `/api/config` remains Electron-only. Web pairing is Bearer. Companion allowlists Local VM routes.
- Host `run_on_bridge` / `run_on_ssh_target` remain the gated real-machine door. Git push from the container needs a bot-scoped deploy key, never `id_ed25519_automation`.

## Live deployed state (verified 2026-09-04 1:00pm CDT)

| Surface | Where | State |
|---|---|---|
| Web | `https://vbot.posival.com` Oracle `/opt/docker/www/vbot` | 200, `Cache-Control: no-store`, asset `index-Cuq0e_bX.js` (contains “Click the preview to drive the browser”), `DEPLOYED_COMMIT=4bf2d2d2` |
| Hub | `https://hub-vbot.posival.com` Servarica `/opt/openmausbot/runtime` | loopback `http://127.0.0.1:8799/api/health` 200 `{"app":"openmausbot","pid":3677782,"static":false}`. `OMB_LOCAL_VM_RELAY=1`. systemd `openmausbot-harness` + `openmausbot-sidecar` |
| Mini bridge | launchd `com.posival.openmaus-bridge` | online `d029c24b-2b35-44c4-80a6-6148e350cad9` caps `shell`+`local-vm`+`hermes` (`Vincents-Mac-mini.local`) |
| Windows bridge | schtasks `OpenMausBotBridge` via `%USERPROFILE%\.openmausbot-bridge\start-bridge.cmd` | online `6b9c61f5-3517-4a59-9abe-25f3af311fef` caps `shell`+`local-vm` (`VincentPC`). Console-session ONLOGON dies on logoff |
| Browser image mini | OrbStack | `localhost/openmausbot/browser-vm:v1` `8d2fae75f260` 1.51GB arm64 |
| Browser image Windows | Docker Desktop linux/amd64 | `localhost/openmausbot/browser-vm:v1` `d9c9b02d5b73` 1.48GB |

Servarica snapshots for this deploy: `server-pre-browservm-20260904125337` + `companion-pre-browservm-20260904125337` (Chicago stamp = 2026-09-04 17:54 UTC). Rollback = `cp -a` those dirs back + restart harness+sidecar.

**Deploy was not clicked.** No fleet browser-vm container is running yet. Vincent still has to pick a machine in Settings and click Deploy.

## What shipped in `4bf2d2d2` (24 files, +887/−601)

Fleet Local VM image is `localhost/openmausbot/browser-vm:v1`: debian bookworm-slim + chromium + git + curl + Node 22.14.0 (pinned sha256) + `/opt/ogb/openmausbot-cdp.mjs`. Caps 1g/1cpu/256m shm/256 pids. DevTools `127.0.0.1:9222`. `--no-sandbox --headless=new`. User `cua`, workspace `/home/cua/workspace`. Labels: `com.openmausbot.local-vm=1`, `com.openmausbot.computer-kind=browser`, `com.openmausbot.image-layer=1`.

**Takeover = screenshot poll + CDP input, not noVNC.** Take control, then click/type the preview. `POST /api/bots/:id/local-computer/input`. noVNC cannot drive a relayed VM on Windows because the viewer proxies `127.0.0.1` on Servarica, not the bridge host. `viewer_url` is empty for fleet Local VM; Watch-screen link is hidden.

Key files:

- `server/browser-vm-image.ts` (+ `.test.ts`) — Dockerfile + CDP helper + `BROWSER_VM_IMAGE`
- `server/container-computer.ts` — IMAGE = BROWSER_VM_IMAGE; VPS still Cua via `server/vps-computer.ts` `CUA_IMAGE`
- `server/local-vm-invoke.ts` — screenshot→cdp jpeg; get_desktop_state→snapshot; open_url→navigate; click→mouse; type_text→type; press_key→key; launch_app refuses GUI apps; computer_exec is `docker exec -u cua -w /home/cua/workspace`
- `server/local-vm-phone-input.ts` — CDP input
- `server/index.ts` — `/local-computer/input` relay; human input allowed when `computerControl.held` even if `LocalVmLease` is held; **not companion-only** (Electron loopback). Sidecar still capability-gates phones
- `bridge/src/local-vm.ts` — jobs `local-vm-status` \| `local-vm-action` \| `local-vm-screenshot` \| `local-vm-input`. Import **must** be `../../server/browser-vm-image.ts`. Action timeout 10 min so first-image build can finish. Auto-build via `prepareBrowserImage`
- `src/components/ComputerPanel.tsx` — Take control = `controlAction("take")` only. When `control.held`, preview clicks/keys POST input. Copy: “Click the preview to drive the browser.”
- `src/components/LocalComputerSection.tsx` / `SettingsPanel.tsx` — 1g/1cpu copy, not Cua 4g/2cpu

`dockerSecurityIsHardened` defaults remain Cua 4g/2cpu/512m/512 pids for VPS. Local VM status passes browser 1g/1cpu/256m/256. Apple container check is 1 CPU / 1g.

## Deploy runbook (do not use `scripts/deploy-cloud-vps.mjs`)

Hub (from this worktree; no `pnpm` on PATH — use `./node_modules/.bin/tsc` / `vitest` / `vite`):

```sh
./node_modules/.bin/tsc -p tsconfig.server.build.json && node scripts/bundle-server.mjs
./node_modules/.bin/tsc -p tsconfig.companion.build.json && node scripts/fix-companion-layout.mjs
ssh servarica 'ts=$(date +%Y%m%d%H%M%S); cp -a /opt/openmausbot/runtime/server /opt/openmausbot/runtime/server-pre-<label>-$ts; cp -a /opt/openmausbot/runtime/companion /opt/openmausbot/runtime/companion-pre-<label>-$ts'
rsync -az --delete dist-server/ servarica:/opt/openmausbot/runtime/server/
rsync -az --delete dist-companion/ servarica:/opt/openmausbot/runtime/companion/
ssh servarica 'systemctl restart openmausbot-harness.service openmausbot-sidecar.service'
# poll http://127.0.0.1:8799/api/health — first curl can race bind; retry
```

Web: `vite build` → `rsync -az --delete dist/ oracle:/opt/docker/www/vbot/` + write short commit into `DEPLOYED_COMMIT`.

Bridges:

- Mini: `tsc -p tsconfig.bridge.build.json` + `scripts/fix-bridge-layout.mjs` → rsync `dist-bridge/` → `~/.openmausbot-bridge/runtime/bridge`. Kickstart launchd. **Do not rewrite the mini plist via `deploy-bridge.mjs`** (it can wipe env).
- Windows has **no rsync**. Copy with `tar -C dist-bridge -czf - . | ssh windows 'Set-Location "$env:USERPROFILE\.openmausbot-bridge\runtime\bridge"; tar -xzf -'` then restart schtask `OpenMausBotBridge`. PowerShell rejects `&&` — use `;`.

Dockerfile dump for prebuild: `node --experimental-strip-types -e "import { browserVmDockerfile } from './server/browser-vm-image.ts'; process.stdout.write(browserVmDockerfile())"`. Mini docker build context `/tmp` hits RustDesk xattr — use a clean ctx dir (`/tmp/omb-browser-vm-ctx`). Windows: `scp` Dockerfile then `docker build -t localhost/openmausbot/browser-vm:v1 "$env:TEMP\omb-browser-vm"`.

## Leftover RAM (mention before Vincent Deploys)

Windows (observed 2026-09-04 ~1:01pm CDT):

- `openmausbot-computer-1bb5959b592e3a93` Cua image Up ~51m healthy (~4g class)
- leftover VPS `openmausbot-vps-94a201dd537d-15ddee8124c6` (`unless-stopped`) Up ~54m healthy
- also `open-webui`, `kokoro-tts`, `open-terminal` on that Docker

Mini:

- `openmausbot-computer` Cua Up 6 days
- `openmausbot-computer-15ddee8124c6afc1` Cua Up 5 days

Do not stop without asking. Shared Deploy creates `openmausbot-computer` (distinct from per-bot `openmausbot-computer-<hash>`).

## Tests already green on this commit

- 8 focused files 88 pass; plus bridge-local-vm/vps-computer/local-vm-phone/companion routes 150 pass; container-computer+worker+browser-vm 44 pass; index.test “open_url through Chromium” 1 pass
- `tsc -b`, `tsconfig.server.json`, `tsconfig.bridge.build.json --noEmit`, `tsconfig.companion.build.json --noEmit` all exit 0
- Worker exec match must use `args.some(arg => String(arg).includes("openmausbot-cdp.mjs"))` because the arg is the full path `/opt/ogb/openmausbot-cdp.mjs`

No `pnpm` on PATH. bun exists at `/opt/homebrew/bin/bun` — do not add bun as a project dep.

## Gotchas that already bit this session

- `origin` push 403 to milind-soni — use `git push personal feat/fleet-models-ui`
- Companion `ERR_MODULE_NOT_FOUND` for `shared/computer-host.ts` — `tsconfig.companion.build.json` must include it
- Windows `docker desktop start` lied “already running”; start `Docker Desktop.exe` via interactive scheduled task. Hub granted only `shell` — added `local-vm` in `/var/lib/openmausbot/bridges.json` without re-pairing
- `/local-computer/input` 409 while a turn holds `LocalVmLease` — allow when `computerControl.held`
- `/local-computer/input` required companion header, which would 403 Electron; removed companion-only check
- Compaction left stray `` `; `` after `browserCdpExecArgs` in `server/browser-vm-image.ts`
- Bridge import `../server/browser-vm-image.ts` resolved to `bridge/server/` — must be `../../server/browser-vm-image.ts`
- ComputerPanel TDZ: `drivingBrowser` used `control` before declaration
- `LocalVmBridgeJob` Extract omitted `local-vm-input`; with four kinds on one BridgeJob variant, Extract became `never`
- Unused `password` on `containerRunArgs` failed `noUnusedParameters` (VNC password gone for fleet VM)
- Hub restart health curl raced bind: `systemctl is-active` was active but listen was not yet
- Tests/fixtures still on Cua 4g/6901/6080 until rewritten for 1cpu/1g/9222/browser labels

## Open work (ranked)

1. Vincent tests: Settings → pick Windows (or mini) as fleet VM location → Deploy → Take control → click the preview. Confirm CDP drive works. **Do not click Deploy for him unless he asks.**
2. If RAM is tight on Windows, stop leftover Cua + unless-stopped VPS containers **after he says so**.
3. OpenBot copy map (delivered, do not implement unless asked): Activity log beside screen; hard refuse while human drives; help TTL + scoped secret box; live CDP screencast while driving. Do not copy SSO/CEL/Intelligence/Helm/per-bot Chromium as a Cua replacement.
4. Isolation PATCH `/api/config` remains Electron-only.
5. Do not merge, do not TestFlight.

## Brain

Search `OpenMausBot fleet Local VM lightweight browser Chromium CDP takeover`. Latest entry 2026-09-04 1:00pm CDT under `Projects/OpenMausBot`.

## Update 2026-09-04 1:35pm CDT (Claude Fable 5.1, after Grok)

Vincent clicked Deploy. Settings → Local VM said "A Local VM already exists"; the Computer pane Deploy then created `openmausbot-computer-15ddee8124c6afc1` (browser image) on Windows and Take control failed with "JSON body must be an object".

Root causes, both fixed and pushed to `personal feat/fleet-models-ui`, **not yet deployed** (auto-mode harness blocked remote rsync/tar; run the runbook above by hand or from an interactive session):

- `3df1c7e5` — shared mode was not shared over the relay. `localVmRelayOpts` sent the bot id, and the bridge always used `perBotLocalVmTarget`, so every bot got its own container and the two Deploy buttons hit two containers. Harness now sends `"shared"`; bridge maps it to `openmausbot-computer` + `~/.openmausbot/vm-home` + label `local-vm-target=shared` (legacy label-less containers still count as managed). Tests in `server/bridge-local-vm-worker.test.ts`.
- `92ba97d2` — `ComputerPanel` screenshot POST had no body; the sidecar requires exactly `{}` on Local VM action/screenshot routes. Plus the Grok Alt design pass (420px chat floor, right pane shrinks then hides, 52px headers, 32px icon buttons, Local VM card spacing).

After deploy: Windows will have two orphans, `openmausbot-computer-15ddee8124c6afc1` (browser, 1g) and `openmausbot-computer-1bb5959b592e3a93` (Cua). Mini's `openmausbot-computer` is the old Cua shared container; the UI will offer "Delete and recreate". Ask Vincent before removing anything.

Open UX question for Vincent: Deploy lives in Settings → Local VM and in the Computer pane. Recommendation is one place (Settings), Computer pane shows status + Take control + "Set up in Settings".

AGY: Sonnet quota exhausted (~2h), Flash not logged in on the mini (`agy-status`). ZCode GLM 5.3 Flash verified the tests; Grok Alt did the design pass.

## Update 2026-09-04 1:59pm CDT (Grok 4.6)

Finished the remaining Local VM closeout on `feat/fleet-models-ui`. Pushed `personal` only. Did not merge, TestFlight, bun, `scripts/deploy-cloud-vps.mjs`, `deploy-bridge.mjs`, or touch the Oracle firewall.

1. **Servarica throwaway removed.** `docker rm openmausbot-computer` → `f51008e49275` (`localhost/openmausbot/browser-vm:v1`, Exited 1). Left `openmausbot-vps-94a201dd537d-15ddee8124c6` (Up 6 days healthy).
2. **Hub POST relay.** `6877e944` — `POST /api/local-computer/run|stop|remove|recreate` and `/screenshot` now relay with `localVmRelayOpts({ id: "shared" })` like GET. Bot-scoped `run|stop|remove` also relay so Computer pane Deploy in shared mode does not 409. `tsc -p tsconfig.server.json --noEmit` exit 0; focused vitest 227 pass + `open_url through Chromium` 1 pass.
3. **Hub redeploy (runbook).** Snapshots `server-pre-postrelay-20260904185401` + `companion-pre-postrelay-20260904185401`. rsync `dist-server` + `dist-companion`. Restart harness+sidecar. Health try 8: `{"app":"openmausbot","pid":3713697,"static":false}` (was 3699024).
4. **Windows E2E (hostId `6b9c61f5-3517-4a59-9abe-25f3af311fef`, mode shared, bot Chief Keef `94a201dd-537d-40be-8da3-e723532c982b`).** Shared container was already up from 18:49 UTC (`2582247b0e4e`, name `openmausbot-computer`, label `com.openmausbot.local-vm-target=shared`, mount `C:\Users\vince\.openmausbot\vm-home` → `/home/cua/workspace`). GET status: `ready: True`, `desktopReady: True`, `container_name: openmausbot-computer`, `workspace_path: C:\Users\vince\.openmausbot\vm-home`. POST run relayed and returned `A Local VM already exists; remove it before creating a replacement` (bridge, not Servarica). POST screenshot HTTP 200 `data:image/jpeg;base64` len 7755. POST take HTTP 200 `held:true`. First click failed: `unsupported job kind: local-vm-input` — `handleJob` omitted that kind. `3b805047` adds it; Windows bridge tar-deployed + schtask `OpenMausBotBridge` restarted (Running). Retry: click `{"text":"ok","isError":false}` HTTP 200, release `held:false` HTTP 200. Mini bridge was **not** redeployed; clicks on the mini will still hit the same dispatcher miss until it is.
5. **Orphans left running (not stopped).** Windows: `openmausbot-computer-15ddee8124c6afc1` (browser-vm, Up 50m), `openmausbot-computer-1bb5959b592e3a93` (Cua, Up 2h healthy), plus leftover VPS `openmausbot-vps-94a201dd537d-15ddee8124c6` (Up 2h healthy). Mini: `openmausbot-computer` Cua Up 6 days, `openmausbot-computer-15ddee8124c6afc1` Cua Up 5 days.

## Update 2026-09-04 2:49pm CDT (Codex closeout)

- Rechecked `feat/fleet-models-ui` at `22e98c18`: working tree clean. Bridge typecheck passed. Focused Local VM suite passed: **7 files / 161 tests**.
- Deployed the corrected bridge to the **Mac mini** using the manual runbook. Backup: `~/.openmausbot-bridge/runtime/bridge-pre-localvm-input-20260904144739`. After `launchctl kickstart -k`, `com.posival.openmaus-bridge` is running with the rebuilt `index.js` containing the `local-vm-input` dispatcher.
- Pushed the same `feat/fleet-models-ui` head (`22e98c18`) to **both** `DaNewChamp/OpenMausBot` and `DaNewChamp/VBot`. Still **no merge** and **no TestFlight**.
- Remaining operator check is to select the Mac mini as the fleet VM location and repeat Deploy → Take control → click/preview input if Vincent wants mini parity proven live.

## Update 2026-09-04: shared takeover source closeout

Continued from `e9030320` in isolated branch `fix/fleet-shared-takeover-0904`. Resource-scoped human takeover, reassignment SSE refresh, and the readiness-to-execution takeover race are repaired and independently tested. Final gate: **3,478 Vitest tests passed / 19 skipped**, all four TypeScript checks, Vite build, and **34 Electron Node tests** passed. No deployment, merge, push, TestFlight, or container cleanup occurred.

Important newly confirmed limitation: native `/api/internal/local-vm/invoke` still executes on the hub instead of relaying to the selected fleet bridge. Manual controls working on Windows do not establish native-bot execution parity. See [the shared takeover closeout](agent-handoff-shared-takeover-20260904.md) for exact workspace, verification evidence, and the next native-relay boundary.

## Update 2026-09-04 4:31pm CDT (Grok 4.6, hub closeout)

Fast-forwarded `fix/fleet-shared-takeover-0904` onto `feat/fleet-models-ui` (`e9030320` → `099664b0`). Pushed `personal` only. Did not merge to main, TestFlight, bun, `scripts/deploy-cloud-vps.mjs`, `deploy-bridge.mjs`, Oracle firewall, or stop/remove any Docker container.

1. **Verify.** `tsc -p tsconfig.server.json --noEmit` exit 0; `tsc -p tsconfig.companion.build.json --noEmit` exit 0; focused vitest 4 files / 36 pass; `server/index.test.ts -t "takeover"` 1 pass / 108 skipped.
2. **Hub redeploy (runbook, web and bridges unchanged).** Snapshots `server-pre-takeover-20260904212950` + `companion-pre-takeover-20260904212950`. rsync `dist-server` + `dist-companion`. Restart harness+sidecar. Health try 5: `{"app":"openmausbot","pid":3770827,"static":false}` (was 3713697).
3. **Windows E2E (hostId `6b9c61f5-3517-4a59-9abe-25f3af311fef`, bot Chief Keef `94a201dd-537d-40be-8da3-e723532c982b`).** GET status HTTP 200 `ready:true` `desktopReady:true` `container_name:openmausbot-computer` `mode:shared`. POST screenshot HTTP 200 `data:image/jpeg;base64` len 7755. POST take HTTP 200 `held:true`. POST click HTTP 200 `{"text":"ok","isError":false}`. POST release HTTP 200 `held:false`.
4. **Shared-hold second bot.** No second `computer=vm` bot exists (15 bots; only Chief Keef is `vm`). Cross-bot hold fan-out was not live-proved.


## Update 2026-09-04 6:57pm CDT: native relay deployed

Code `88f4090a` on `feat/fleet-models-ui` is pushed to both personal OpenMausBot and private VBot. Native tools now relay to the selected bridge with actual bot/thread ownership, per-command authenticated preflight, cancellation, no pinned-host fallback, and correct JPEG MIME. Full gate: **3,511 passed / 19 skipped**, four typechecks, all builds and built bridge imports, and **34 Electron tests**. Hub, companion, Mini bridge, and Windows bridge deployed with backups; services healthy and both bridges online. No main merge, TestFlight, VM cleanup, or assignment change.

**Native model-to-Windows E2E is now proven live:** a disposable Cursor / auto VM bot emitted a native screenshot call, hub job `f29a9866-d555-401e-bfc8-15e4300b1aa6` ran on the selected Windows bridge against target `shared`, returned a valid JPEG, and Cursor completed the turn with `done`. The temporary bot was cleaned up and permanent bot settings were untouched. Exact evidence, runtime hashes, backups, and review disposition are in [the native relay handoff](agent-handoff-native-vm-relay-20260904.md).
