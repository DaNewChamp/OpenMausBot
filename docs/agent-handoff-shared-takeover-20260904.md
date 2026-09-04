# V Bot shared Local VM takeover closeout

Date: 2026-09-04

## Workspace and boundaries

Current continuation: `/Users/Vincent/Github/.worktrees/vbot-fleet-review-0904`, branch `fix/fleet-shared-takeover-0904`, based on `e9030320755126485dfd9565b0e51b3139b86276` from `feat/fleet-models-ui`.

The original feature worktree is `/Users/Vincent/Github/.worktrees/fleet-models-ui`. It remains clean at the base commit. The root `/Users/Vincent/Github/OpenMausBot` checkout has unrelated Peekaboo changes and build outputs; those were not touched. Private `main` is stale and is not the right continuation base.

This closeout is source-only. No merge, push, deployment, TestFlight release, service restart, fleet location change, or container creation/removal was performed. Bots remain on the Servarica hub. Existing Mac mini Cua containers remain intact. Keep the prior manual deployment runbook and no-merge/no-TestFlight boundaries.

## Implemented and independently verified

Human holds now use the effective selected host and canonical Local VM target as their identity. Bots explicitly configured with `computer: "vm"` share a hold when they share that resource. Other computer destinations and per-bot VM targets remain independent. Help reasons, request IDs, and help expiry remain per bot.

Take and release publish the effective state to each affected bot through the existing SSE event format. Public GET, hydration, internal control polling, and the input gate read the same resource-scoped state. Deleting one bot does not release a resource still used by a peer. Reassignment does not carry the old machine's hold onto a new machine, and scope-change notifications keep the UI in sync.

The internal native invoke route retains boot-token and bot/thread ownership checks. It rejects a human-held resource before readiness work and checks again immediately before container execution. The second check closes a reproduced race where a takeover during an awaited readiness probe previously allowed the queued browser action to execute.

Files: `server/computer-control.ts`, `server/computer-control.test.ts`, `server/index.ts`, `server/index.test.ts`.

## Evidence

Before this patch, the root session independently ran the baseline gate: 3,465 Vitest tests passed, 19 skipped; frontend/server/bridge/companion TypeScript checks passed; Vite production build passed; 34 Electron Node checks passed.

Thirteen regression cases were added. Shared-control HTTP tests failed before implementation because the second bot never received the hold. Root review added and reproduced two more edge cases: missing SSE refresh after reassignment, and an in-flight readiness request returning HTTP 200 instead of refusing after takeover. Both were repaired. Tests use isolated homes, fake CLIs, and a throwaway fake Docker runtime; no live browser or credentials were used. Screenshot observations from the UI poller are allowed in the execution-race test, but no browser input may execute.

Final root verification completed successfully, confirmed from the original log after a transient Mac tunnel failure:

- Full Vitest floor: **3,478 passed, 19 skipped**, 3,497 registered; 332 passing files, 2 skipped files.
- `tsc -b`: passed.
- `tsc -p tsconfig.server.json --noEmit`: passed.
- `tsc -p tsconfig.bridge.build.json --noEmit`: passed.
- `tsc -p tsconfig.companion.build.json --noEmit`: passed.
- Vite production build: passed.
- Five Electron Node test files: **34 passed**, zero failed.
- `git diff --check`: passed.

Log: `/tmp/vbot-shared-takeover-final-gate-20260904.log`. The log ends with `=== GATE COMPLETE ===`; no test-floor process remained when checked. The earlier Brain note saying the final gate was unknown is superseded by these retrieved results.

The implementation worker timed out after writing a usable partial patch. The root session reviewed, completed, and verified the actual files. A separate read-only reviewer could not start because its sandbox rejected a Docker socket symlink. No sandbox protections were disabled; there is no independent reviewer sign-off to claim.

## Remaining native execution gap

The fleet browser-VM wave is NOT complete. Human status/lifecycle/screenshot/input routes relay to the selected fleet bridge, but `/api/internal/local-vm/invoke` still calls hub-local `ensureLocalVmForTurn`, `containerComputerStatus`, and `localVmCommandRunner`. The bridge protocol has only status/action/screenshot/input jobs, not a native invoke job. This is confirmed by source inspection, not a live native-bot E2E failure reproduced in this session.

The next bounded implementation should introduce a typed native Local VM invoke relay with capability checks, preserve bot/thread authorization before mapping to the shared target, run only inside the selected container, and refuse an offline or incompatible pinned bridge rather than silently falling back to the hub. Exercise it with an authenticated owned-turn HTTP test and a fake bridge, including takeover and stop/lease behavior. Check the bridge build layout and runtime imports, not only source types.

Related source-level issue to verify in that pipeline: browser screenshots are JPEG while `local-vm-invoke-proxy.ts` currently advertises `image/png` for image content.

Do not claim live Mac mini Chromium parity: it was not tested here because recreating the existing old Cua container was not authorized. Do not combine this work with the separate secure-login plan.
