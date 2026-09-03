# OpenMausBot upstream adoption handoff

## Purpose

Give the next Grok worker a bounded, evidence-backed adoption queue from upstream OpenMausBot without replacing V Bot's fleet, Hermes, security, or iOS product direction.

## Starting point

- Repository: `DaNewChamp/VBot`
- Branch: `feat/vbot-hermes-ux-bot-chat`
- Product baseline before this handoff: `476e6b6e`
- Upstream repository: `milind-soni/OpenMausBot`
- Previously reviewed upstream baseline: `a3d2870528fbe185c978bb6ffda0decc8fd8a365`
- Newest reviewed upstream commit: `39d5202c00bd8dda33c6af7e33f96e6ce83b9ed4`
- Upstream comparison: <https://github.com/milind-soni/OpenMausBot/compare/a3d2870528fbe185c978bb6ffda0decc8fd8a365...39d5202c00bd8dda33c6af7e33f96e6ce83b9ed4>
- Latest reviewed release: [v0.1.50](https://github.com/milind-soni/openmausbot-releases/releases/tag/v0.1.50)

Do not cherry-pick this 51-commit range wholesale. V Bot has diverged substantially. Inspect the upstream diff, reproduce only the useful behavior against V Bot's current contracts, and keep each concern in a separate commit.

## Required orientation

Before editing:

1. Inspect the current branch, remotes, status, recent commits, and all worktrees.
2. Read `README.md`, `docs/v-bot-architecture.md`, `docs/VBOT_DESKTOP_ARCHITECTURE.md`, `docs/hermes-adapter.md`, `docs/bridge-agent.md`, `docs/ios-companion.md`, and the current distributed-platform Wave plans.
3. Compare each candidate below against the current V Bot implementation and tests. Mark already-equivalent work `NOOP` rather than adding a second implementation.
4. Work in a clean isolated worktree based on the current branch head. Preserve unfamiliar work.

## Wave A — adopt now

### A1. Secure iOS credential-request card

Source: [`5ada6e51`](https://github.com/milind-soni/OpenMausBot/commit/5ada6e5146885970f3b4c5808b3029c3f5c0783d)

V Bot already has server-side `request_credential`, secret-card state, resume, dismiss, and allowlisted credential targets. Add the missing iOS presentation:

- Render pending, saved/resumed, declined, and error states in the transcript.
- Explain which allowlisted credential is needed and why.
- For this wave, mobile is display/handoff only. Never accept or echo a secret in ordinary chat.
- Point the user to the correct paired computer, not a generic desktop sentence when fleet placement is known.
- Keep HTTPS help links sanitized: no userinfo, embedded password, non-HTTPS scheme, or untrusted deep link.
- Preserve hooks for the later native OAuth/browser-login flow; do not implement cookie transfer in this task.
- Add decoding, accessibility, Dynamic Type, and small-screen tests.

### A2. ACP startup and reconnect hardening

Sources: [`ed7a1515`](https://github.com/milind-soni/OpenMausBot/commit/ed7a1515), [`54e3edfb`](https://github.com/milind-soni/OpenMausBot/commit/54e3edfb)

- Add bounded, configurable initialization/request/session-load timeouts where V Bot's ACP core lacks them.
- Treat a successful RPC envelope with a null or malformed session-load result as unavailable, never as a valid empty session.
- Prove reconnect and duplicate-prevention behavior.
- Apply the generic ACP fixes once; do not create provider-specific copies.

### A3. Honest failed-turn notifications

Sources: [`2689be08`](https://github.com/milind-soni/OpenMausBot/commit/2689be08), [`bfe6df25`](https://github.com/milind-soni/OpenMausBot/commit/bfe6df25), [`bb0a36d9`](https://github.com/milind-soni/OpenMausBot/commit/bb0a36d9)

- Notify when a requested turn dies before the engine actually begins.
- Preserve one terminal notification per logical turn across reconnect/retry.
- Do not send duplicate approval-card continuation alerts.
- Keep notification text free of prompts, paths, tokens, stderr, and secret-shaped data.

### A4. Interval routines and active-history correctness

Sources: [`50ddda4d`](https://github.com/milind-soni/OpenMausBot/commit/50ddda4d), [`e74e85c1`](https://github.com/milind-soni/OpenMausBot/commit/e74e85c1), [`75b7c154`](https://github.com/milind-soni/OpenMausBot/commit/75b7c154)

- Add every-X-minutes/hours schedules to the existing V Bot routine contract.
- Enforce a safe minimum interval and retain existing schedule limits.
- Preserve active history and next-run state during edits, hydration, and app reconnect.
- Implement one canonical wire format across server, iOS, web, and desktop.
- Keep the editor simple: schedule type, interval, active toggle, next run. Avoid nested menus.

### A5. Computer-view reliability and keyboard policy

Sources: [`9f27177a`](https://github.com/milind-soni/OpenMausBot/commit/9f27177a), [`4eedf162`](https://github.com/milind-soni/OpenMausBot/commit/4eedf162), [`48ed8acb`](https://github.com/milind-soni/OpenMausBot/commit/48ed8acb)

- Add an explicit desktop-viewer keyboard permission policy rather than assuming focus grants input.
- Make keyboard capture/release deterministic and accessible.
- Settle a screenshot only after a computer action actually produces a changed frame; do not resend unchanged pixels as success.
- Fit this into V Bot's selected-computer/bridge/VM model. Do not weaken local permission or approval gates.

## Wave B — adapt after Wave A is green

### B1. Official Antigravity ACP runtime

Sources: [`6dbe5ae8`](https://github.com/milind-soni/OpenMausBot/commit/6dbe5ae8), [`95d27799`](https://github.com/milind-soni/OpenMausBot/commit/95d27799), [`54e3edfb`](https://github.com/milind-soni/OpenMausBot/commit/54e3edfb)

Replace only the obsolete Antigravity transport pieces with Google's official ACP runtime where compatible. Preserve V Bot's provider catalog, engine identity, routing, pairing, and secret boundaries. Require discovery, setup, resume, stop, malformed-frame, timeout, and reconnect tests before adoption.

### B2. Per-bot “Works on” destination

Sources: [`8458db41`](https://github.com/milind-soni/OpenMausBot/commit/8458db41), [`d8716d96`](https://github.com/milind-soni/OpenMausBot/commit/d8716d96)

Adapt this as one clear per-bot execution destination:

- This device
- A selected fleet computer/bridge
- Local VM
- Cloud/VPS workspace
- Browser session

Use stable machine IDs under friendly names. Do not confuse runtime/provider selection with where tools execute. An offline or unreadable destination is unavailable, never silently replaced.

### B3. Model-catalog refresh hardening

Sources: [`3ab2426d`](https://github.com/milind-soni/OpenMausBot/commit/3ab2426d), [`4a72db41`](https://github.com/milind-soni/OpenMausBot/commit/4a72db41)

V Bot already has refresh UI and a refresh gate. Diff the upstream race/error tests and adopt only missing protections. Keep the curated short subscription-first model list and the separate 1M-context toggle; do not re-expand the picker.

### B4. Animated user and bot avatars

Source: [`9f6f531b`](https://github.com/milind-soni/OpenMausBot/commit/9f6f531b)

Add bounded GIF/APNG frame playback to the existing avatar upload/crop flow. Respect Reduce Motion, memory limits, image-size limits, and static fallbacks. Do not replace V Bot's custom avatar and crop UI.

### B5. Web/desktop Tools and profile navigation

Source: [`d2635669`](https://github.com/milind-soni/OpenMausBot/commit/d2635669)

Use the information architecture, not the upstream styling: one profile entry, one Tools/Connections entry, and a compact secondary menu. Keep iOS navigation unchanged unless a shared contract requires it.

### B6. Goal composer shortcut

Source: [`3ba0ba0d`](https://github.com/milind-soni/OpenMausBot/commit/3ba0ba0d)

Consider `/goal` as a discoverable shortcut that opens V Bot's existing goal flow. Do not build a second goal system or clutter the composer. Keep temporary-agent activity represented by the existing compact pill/fan-up UI.

## Review only / likely ignore

- Android mascot bodies: V Bot has its own avatar language.
- Android attachment implementation: use only as contract/test reference where V Bot web or iOS still lacks file preview; do not port Kotlin UI.
- Upstream sidebar styling: V Bot's design is authoritative.
- Release version bumps and Windows cleanup: unrelated to this feature wave unless the release pipeline is separately scheduled.
- Upstream secrets-in-`config.json` assumptions: never adopt. V Bot secret stores remain encrypted/unavailable-on-read-error.

## Global invariants

- Harness remains loopback-only.
- Account login discovers hubs but never replaces device pairing.
- Existing installation identity is adopted rather than replaced.
- Unreadable identity, credential, or secret state is unavailable, never empty.
- No secret may appear in config JSON, logs, argv, snapshots, fleet metadata, error messages, notifications, or chat.
- Preserve current Hermes MCP, bot-to-bot transcript, fleet bridge, VM, and iOS contracts.
- Do not add, remove, or upgrade dependencies without Vincent's approval.
- Do not merge, deploy, restart production, modify DNS/Cloudflare/Servarica, publish desktop artifacts, or upload TestFlight in this task.

## Execution contract for Grok

1. Produce a read-only gap matrix for A1–A5 against current V Bot before editing.
2. Implement Wave A only, in order, with test-first task-sized commits. Parallelize only files that do not overlap.
3. Do not start Wave B early. Record each B item as `READY`, `NOOP`, or `BLOCKED` with evidence.
4. Run focused tests after every task, then the full TypeScript/Vitest and Swift/Xcode gates required by the repository.
5. For visible iOS work, run simulator/device UI checks and capture screenshots. Simulator evidence is not a TestFlight release gate.
6. Review the final diff for secret leakage, route widening, duplicate side effects, state resurrection, and compatibility regressions.
7. Return exact commits, files changed, commands and results, screenshots, residual risks, and the safe next action.

## Completion definition

Wave A is complete only when the secure credential card, ACP hardening, failed-turn notification behavior, interval routines, and computer-view reliability are each backed by focused tests and the full repository gates. A source diff or successful build alone is not completion.
