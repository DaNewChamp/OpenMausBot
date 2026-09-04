# V Bot native Local VM relay: September 4, 2026 closeout

## Verified state

Code commit: `88f4090a3f24fea9037627c799859043f5095d4a`.
Feature branch: `feat/fleet-models-ui`, pushed to both `personal` (DaNewChamp/OpenMausBot) and `vbot-private` (DaNewChamp/VBot). No main merge and no TestFlight upload.

Task worktree: `/Users/Vincent/Github/.worktrees/vbot-native-relay-0904`, branch `fix/vbot-native-relay-0904`.
Canonical fleet worktree: `/Users/Vincent/Github/.worktrees/fleet-models-ui`.
Base was `80ff2b12`, which already included deployed shared takeover (`099664b0`). The private remote was initially behind; it was brought up to the verified base before this implementation.

**The fix is deployed to the hub, sidecar, and both bridge runtimes. The complete model-to-Windows native screenshot path is NOT yet live-proved.** See the live smoke limitation below. Do not convert passing fixtures or healthy services into a claim of native provider parity.

## What changed

Native `POST /api/internal/local-vm/invoke` no longer ignores the selected fleet bridge and always executes on the hub. It uses typed `local-vm-invoke` jobs. A pinned host wins even when the hub has Docker. An offline, unpaired, ungranted, or incompatible bridge fails closed; there is no silent fallback to another host.

Shared mode maps to `shared` / `openmausbot-computer`. Per-bot target identity is preserved. Native execution uses only the selected managed browser container. Shell tools run as `cua` in `/home/cua/workspace`, never in the host shell. Existing incompatible Cua containers are blocked rather than automatically deleted or recreated.

The authenticated native route now checks the actual bot plus owning active thread before mapping to a shared container. Previously, a peer VM bot could borrow another bot's active thread. Root independently reproduced that bug over real HTTP with a disposable home/runtime: the old code returned 200 and dispatched one CDP input; the patched code returns 403 and dispatches zero inputs. Valid owner and stop checks also pass.

An in-memory invocation context tracks the owning bot/thread, computer resource, job IDs, and abort controller. Ownership, lease, stopped-thread, takeover, and assignment checks are repeated across awaited readiness, queueing, execution, and result boundaries. Queued and delivered work is canceled on stop, takeover, reassignment, disconnect, or timeout. An unrelated cloud computer hold does not cancel the shared VM. Orphan native jobs cannot execute after a hub restart because they lack a live invocation context.

Bridge workers perform authenticated, job-generation-specific preflight immediately before each native command, including commands after awaited readiness. Endpoint: `POST /api/bridge/local-vm/authorize`. The companion permits only that exact daemon route to pass bridge authentication; it is not browser/CORS safe and does not expose bridge administration. AbortSignal reaches native command execution. Canceling a Docker client is not a guarantee that an already-running guest process has terminated.

Screenshots carry explicit supported MIME information through the hub into MCP. JPEG is no longer advertised as PNG; legacy PNG remains supported. Remote invocation results are shape-validated. The bridge build includes the shared executor and its dependencies, and built runtime imports were executed successfully.

## Verification evidence

Final complete test run, exit 0:

- `/tmp/vbot-native-relay-final-tests-0904.log`
- 333 test files passed, 2 skipped.
- 3,511 tests passed, 19 skipped (3,530 counted).
- All 119 HTTP tests passed, including owner/peer, selected bridge, per-bot target, offline/old bridge, queued stop/takeover, delivered-job preflight, wrong bridge, stale generation, unrelated cloud hold, reassignment, and JPEG coverage.
- Root standalone ownership and stop smoke passed after the entire suite.
- `git diff --check` passed. Final marker: `FINAL TEST GATE COMPLETE` at 18:45:36 CDT.

Build gate, exit 0: `/tmp/vbot-native-relay-build-gate-0904.log`.
Frontend, server, bridge, and companion typechecks passed. Vite, server, companion, and bridge builds passed. Actual built bridge modules imported successfully. Five Electron Node suites passed all 34 tests.

Fresh release artifacts were rebuilt after the full test gate because build-contract tests can rewrite generated output. Log: `/tmp/vbot-native-relay-release-build-0904.log`. The build itself passed; a subsequent checksum command initially named nonexistent companion/server.js, then the correct companion/index.js was verified separately.

Root reproduction script: `/tmp/vbot-native-owner-smoke-0904.mjs`. Original failing evidence: `/tmp/vbot-native-owner-baseline-0904.log`.

Two full-run fixture issues were corrected before the final green gate: fake Docker incorrectly reported every per-bot container name as existing, so an unchecked isolation reset failed and leaked per-bot mode; the fixture now reports only its shared container and reset status is asserted. An existing Hermes error-classification test could race a 500 ms child startup deadline; its fixture initialization budget is 5 seconds while the deliberate RPC-timeout case retains a 500 ms request deadline. Production timeout behavior was not changed.

## Independent review disposition

Grok 4.6 High wrote the initial patch and timed out before verification. Root inspected and corrected the actual caller/callee paths, cancellation, response guards, tests, and companion routing. Worker output was not treated as final authority.

Safe tool-based reviews could not operate under their tool/sandbox constraints; those constraints were not removed. A separate safe, plaintext-only AGY review completed. Report: `/tmp/vbot-native-relay-review-plaintext-0904.log`. Its three findings were checked against full source rather than accepted blindly:

1. An undefined adapter turn ID was alleged to permit post-turn execution. Native drivers do not necessarily use adapter task IDs; the authoritative busy-aware VM lease, stopped-thread marker, and synchronous turn-completion lease/map cleanup close the described post-turn scenario. Do not add a blanket `!turnId` guard that breaks native drivers.
2. It alleged `job.bridgeId` was absent. `LocalVmBridgeJob` inherits it from `BridgeJobBase`; the premise was false.
3. It alleged an authorization refusal reported as a tool error would make a canceled job successful. Preflight refusal cancels the registry job; `storeResult` gives cancellation precedence over worker exit code, and the native HTTP result guard rechecks ownership. The relevant no-input and cancellation tests passed.

These are dispositions of the reported scenarios, not a claim that every possible race has been formally eliminated.

## Deployment and rollback

Before restarting, all 15 permanent bots were idle and there were no queued/running bridge jobs. No assignment or isolation setting was changed.

Backup stamp: `20260904T234638Z` (also `/tmp/vbot-native-relay-deploy-stamp-0904`).

- Servarica server: `/opt/openmausbot/runtime/server-pre-native-20260904T234638Z`
- Servarica companion: `/opt/openmausbot/runtime/companion-pre-native-20260904T234638Z`
- Mini bridge: `~/.openmausbot-bridge/runtime/bridge-pre-native-20260904T234638Z`
- Windows bridge: `C:\Users\vince\.openmausbot-bridge\runtime\bridge-pre-native-20260904T234638Z`

Windows backup initially encountered a preexisting malformed AppleDouble `._.` entry. Application backup completed with robocopy excluding `._*`; the old index hash was verified against the backup. Original metadata was not deleted. New tar extraction used COPYFILE_DISABLE and excluded AppleDouble files.

Hub and companion were copied into their existing runtime directories, then `openmausbot-harness` and `openmausbot-sidecar` restarted. Health recovered with hub PID 3822201. Sidecar PID 3822202 was active/running, restart count 0, exit status 0. Live hashes matched release artifacts. Public `/api/bridge/local-vm/authorize` returns 401 without bridge authentication. A guessed loopback sidecar port 8810 refused connection, while the actual public route worked; do not interpret that guessed-port failure as a sidecar crash.

Mini bridge runtime: `~/.openmausbot-bridge/runtime/bridge`; launchd `com.posival.openmaus-bridge` restarted without rewriting its plist/environment. Windows runtime: `C:\Users\vince\.openmausbot-bridge\runtime\bridge`; scheduled task `OpenMausBotBridge` restarted and reported Running. Its Node command is relative `index.js run`; the exact old bridge process was identified through the bridge launcher parent, not by killing every Node process. Both bridges subsequently reported online.

Release SHA-256:

```text
bridge/index.js    735091d9d4bdaa2dccf2b2c5b75778d03fbf3893f458806d006aa2614cb3c748
server/index.js    d96531827151617303a9ea59e054e9bad93cf03375b12b9672deb20e99127fff
companion/index.js 918f2763750f9833247242aef5657ecacec3c580c2e8817da11b44d44bae5258
```

A rollback should restore these runtime snapshots and restart only the corresponding idle services after checking live bot/job state. Do not alter credentials, service environments, Docker containers, or unrelated applications.

## Live native smoke: remaining validation

Global mode/host remained shared Windows (`6b9c61f5-3517-4a59-9abe-25f3af311fef`). GET `/api/local-computer` confirmed the existing shared browser container ready before the check. Permanent Chief Keef bot `94a201dd-537d-40be-8da3-e723532c982b` uses Cursor / auto. No permanent bot was reconfigured.

A disposable VM bot copied that model selection and was asked for exactly one screenshot, without navigation, input, shell execution, or file changes. Permission settings were not broadened. It failed to finish within the verification window. The live bridge job audit contains **no job at all for that verification thread**, so this attempt did not reach the native relay. The provider/tool-mount/approval cause is unconfirmed.

Temporary bot `74204c32-a32b-45b4-8ca2-2bdf0fb41309`, thread `fc07b2d1-d917-4ede-8b0a-1f306889433f`, was interrupted and deleted in cleanup. The log confirms 15 bots remain. The smoke job is terminal; no worker was left monitoring it.

- Script: `/tmp/vbot-native-live-smoke-0904.py`
- Log: `/tmp/vbot-native-live-smoke-0904.log`
- Managed job: `20260904T235138-command-b45b43e6` (failed, exit 1; verification timeout, cleanup completed).

Next bounded investigation is why the native Cursor turn did not emit the screenshot job. Inspect provider readiness, tool mount, and approval state before changing relay code or broadening permissions. A successful future live check must prove an owned native turn creates a Windows `local-vm-invoke` screenshot job for target `shared`, completes with a valid JPEG, and is cleaned up afterward. Passing manual screenshot controls alone does not establish that path.

## Preserved boundaries

No main merge, TestFlight, Oracle/web deployment, firewall change, fleet reassignment, image rebuild, or Docker stop/remove/recreate. Existing Windows shared/per-bot browser and legacy Cua/VPS containers and Mini Cua containers were left alone. Root `/Users/Vincent/Github/OpenMausBot` unrelated dirty Peekaboo/build/package/docs work was not reset, stashed, cleaned, staged, or committed.
