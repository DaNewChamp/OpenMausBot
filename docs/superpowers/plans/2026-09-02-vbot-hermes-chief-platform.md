# V Bot Hermes Chief Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes a first-party V Bot runtime that can safely power or rebind any bot while preserving V Bot identity, native Hermes learning/MoA behavior, fleet controls, and thin-client UX.

**Architecture:** V Bot remains the authoritative organization, transcript, hierarchy, approval, and fleet layer. A versioned runtime binding points a stable bot to a provider runtime or a specific Hermes profile; a loopback-only bridge connector exposes V Bot tools to Hermes and projects Hermes capabilities/events back into V Bot. Cloudflare/PocketID web and voice are later gated waves built on the same contracts.

**Tech Stack:** TypeScript, Fastify, Vitest, pnpm, Swift/SwiftUI, XCTest/Swift Testing, Hermes ACP/MCP, V Bot bridge protocol, Cloudflare Workers/D1/Access, PocketID OIDC.

## Global Constraints

- Execute waves in order and do not implement a later wave early.
- Use test-driven development and one task-sized commit per task.
- Add no dependency without Vincent’s approval.
- Preserve unfamiliar work; never reset, clean, stash, force-push, or rewrite shared history.
- The harness and Hermes connector remain loopback-only.
- Account login discovers hubs but never replaces device pairing.
- Adopt existing desktop and Hermes installation identities rather than replacing them.
- Existing desktop account and managed endpoint behavior stays compatible.
- An unreadable identity or secret store is unavailable, never empty.
- Secrets cannot appear in `config.json`, logs, argv, fleet metadata, snapshots, transcripts, or error messages.
- Existing iOS behavior remains unchanged until the explicit iOS projection task.
- Capability negotiation must fail closed; never fake an unsupported Hermes function.
- Do not deploy, touch DNS, modify production Cloudflare resources, publish desktop artifacts, or upload TestFlight from an implementation worker.

---

## Baseline Gate

- [ ] Record `hostname`, `git status --short`, `git log -5 --oneline --decorate`, `git worktree list --porcelain`, and `git rev-parse vbot-private/main`.
- [ ] Read the design spec and the existing Hermes, distributed-platform, bridge, web, and voice plans named in the design.
- [ ] Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, and the existing Hermes/bridge focused tests. Stop on a baseline failure and report it without changing code.
- [ ] Confirm no secret-shaped values exist in staged output with `git diff --cached --check` and the repository’s secret scan before every commit.

## Wave 1 — Stable Runtime Binding and Hermes Conversion

### Task 1: Versioned runtime-binding domain

**Files:**
- Create: `server/bot-runtime-binding.ts`
- Create: `server/bot-runtime-binding.test.ts`
- Modify: `server/store.ts`
- Modify: `server/engines/bindings.ts`

**Interfaces:**
- Produces: `BotRuntimeBinding`, `RuntimeRebindRequest`, `planBotRuntimeRebind(input): RuntimeRebindPlan`, and `applyBotRuntimeRebind(plan): Promise<BotRecord>`.
- Preserves: existing provider bindings and legacy Hermes records through read-time normalization only.

- [ ] **Step 1: Write failing domain tests** for provider normalization, local/bridge Hermes placement, idle-only rebinding, missing/unreadable endpoint failure, preserved bot identity fields, and a sanitized context handoff that rejects secret-shaped keys.
- [ ] **Step 2: Run** `pnpm exec vitest run server/bot-runtime-binding.test.ts` and verify failures identify the missing exports.
- [ ] **Step 3: Implement the discriminated union and pure planner.** The planner must return `{ previous, next, preservedBotId, handoffSummary, requiresApproval }`; it must not write storage.
- [ ] **Step 4: Implement transactional application** using the existing store update primitive. Re-read bot state immediately before the write and reject if the bot became active or the endpoint capability revision changed.
- [ ] **Step 5: Run** `pnpm exec vitest run server/bot-runtime-binding.test.ts server/engines/bindings.test.ts` and `pnpm typecheck`.
- [ ] **Step 6: Commit** `feat(hermes): add safe bot runtime bindings`.

### Task 2: Approved runtime conversion API and agent tool

**Files:**
- Create: `server/bot-runtime-rebind.ts`
- Create: `server/bot-runtime-rebind.test.ts`
- Modify: `server/index.ts`
- Modify: `server/drivers/agents-proxy.ts`
- Modify: `server/contracts.ts`

**Interfaces:**
- Consumes: `planBotRuntimeRebind` and `applyBotRuntimeRebind` from Task 1.
- Produces: `POST /api/internal/bots/:botId/runtime-binding` and MCP tool `configure_bot_runtime`.

- [ ] **Step 1: Write failing route/tool tests** covering direct-user request, Hermes-initiated request requiring approval, stale target state, unknown bridge/profile, reverse conversion to provider, and redaction of endpoint errors.
- [ ] **Step 2: Run** `pnpm exec vitest run server/bot-runtime-rebind.test.ts server/drivers/agents-proxy.test.ts` and confirm the new route/tool are absent.
- [ ] **Step 3: Add the request contract:** `{ targetBotId, binding, contextMode: "summary" | "none", userRequested: boolean }`. Return a pending approval for autonomous changes and apply only after the existing approval service authorizes the exact binding fingerprint.
- [ ] **Step 4: Register `configure_bot_runtime`** with plain-language output: target bot, source runtime, destination computer/profile, preserved data, and whether a restart is required. Never include tokens, filesystem secret paths, or provider session IDs.
- [ ] **Step 5: Run focused tests and** `pnpm typecheck`.
- [ ] **Step 6: Commit** `feat(hermes): expose approved runtime conversion`.

### Task 3: Bridge-local Hermes endpoint discovery

**Files:**
- Create: `bridge/src/hermes-endpoints.ts`
- Create: `bridge/src/hermes-endpoints.test.ts`
- Modify: `bridge/src/hermes.ts`
- Modify: `bridge/src/types.ts`
- Modify: `server/bridge-hermes.ts`
- Modify: `server/bridge-hermes.test.ts`

**Interfaces:**
- Produces: `HermesEndpointDescriptor { endpointId, bridgeId, profile, displayName, capabilities, capabilityRevision, status }`.
- Emits metadata only; authentication material never leaves the bridge.

- [ ] **Step 1: Write failing tests** for multiple local profiles, friendly-name generation, unreadable profile stores, duplicate installations, capability revision changes, and metadata redaction.
- [ ] **Step 2: Run** `pnpm exec vitest run bridge/src/hermes-endpoints.test.ts server/bridge-hermes.test.ts`.
- [ ] **Step 3: Implement read-only discovery** by extending existing Hermes probes. Derive stable endpoint IDs from the adopted bridge identity plus profile name; never hash secret contents.
- [ ] **Step 4: Publish descriptors** over the existing paired bridge heartbeat and retain the last known descriptor only while its identity store remains readable.
- [ ] **Step 5: Run focused tests,** `pnpm build:bridge`, and `pnpm typecheck`.
- [ ] **Step 6: Commit** `feat(bridge): discover local Hermes endpoints`.

### Task 4: First-party Hermes connector and MCP facade

**Files:**
- Create: `bridge/src/hermes-vbot-connector.ts`
- Create: `bridge/src/hermes-vbot-connector.test.ts`
- Create: `bridge/src/hermes-vbot-mcp.ts`
- Create: `bridge/src/hermes-vbot-mcp.test.ts`
- Create: `integrations/hermes-vbot/README.md`
- Modify: `bridge/src/index.ts`
- Modify: `server/drivers/agents-proxy.ts`

**Interfaces:**
- Produces: a Unix-socket/loopback connector and stdio MCP facade.
- Exposes only approved V Bot roster, messaging, delegation, runtime conversion, room, routine, skill, and scoped computer tools already registered in `agents-proxy.ts`.

- [ ] **Step 1: Write failing transport tests** proving non-loopback bind rejection, missing peer credential rejection, request correlation, reconnect behavior, payload limits, and stdout/log redaction.
- [ ] **Step 2: Run** `pnpm exec vitest run bridge/src/hermes-vbot-connector.test.ts bridge/src/hermes-vbot-mcp.test.ts`.
- [ ] **Step 3: Implement connector framing** over the existing bridge identity. The stdio process receives only a socket location and bot scope; it never receives the hub token in argv or config.
- [ ] **Step 4: Add a one-click setup operation** that writes only non-secret Hermes connector metadata after showing the exact profile and V Bot hub. Re-running must adopt/update the existing entry rather than duplicate it.
- [ ] **Step 5: Document manual fallback commands** without embedding credentials or production hostnames.
- [ ] **Step 6: Run focused tests, builds, typecheck, and the repository secret scan.**
- [ ] **Step 7: Commit** `feat(hermes): add first-party V Bot connector`.

### Task 5: Hermes capability and agent-event projection

**Files:**
- Create: `server/hermes-capabilities.ts`
- Create: `server/hermes-capabilities.test.ts`
- Create: `server/hermes-agent-projection.ts`
- Create: `server/hermes-agent-projection.test.ts`
- Modify: `server/hermes-bridge-integration.ts`
- Modify: `server/hermes-groups.ts`
- Modify: `server/store.ts`

**Interfaces:**
- Produces: capability manifest fields for memory, learning, skills, MoA, routines, approvals, groups, messaging, events, final response, queueing, steering, attachments, and computer tools.
- Produces events: `subagent.started`, `subagent.updated`, `subagent.completed`, and `subagent.promoted`.

- [ ] **Step 1: Write failing tests** showing unsupported capabilities are unavailable, named persistent Hermes agents become stable bots, temporary agents remain nested activities, completion retains transcript access, and promotion preserves provenance.
- [ ] **Step 2: Run** `pnpm exec vitest run server/hermes-capabilities.test.ts server/hermes-agent-projection.test.ts`.
- [ ] **Step 3: Implement capability negotiation** from real Hermes responses and bridge descriptors. Do not infer support from version strings alone.
- [ ] **Step 4: Implement idempotent agent projection.** Persistent Hermes IDs map to one bot ID; temporary IDs map to one parent-chat activity until explicitly promoted.
- [ ] **Step 5: Run focused tests and** `pnpm typecheck`.
- [ ] **Step 6: Commit** `feat(hermes): project capabilities and subagents`.

### Task 6: iOS Hermes runtime and temporary-agent UX

**Files:**
- Modify: `ios/App/HermesSetupView.swift`
- Modify: `ios/App/HomeActivityPill.swift`
- Modify: `ios/App/ActivityRunChip.swift`
- Modify: `ios/App/AgentProfileView.swift`
- Modify: `ios/App/ModelPickerView.swift`
- Modify: `ios/Sources/CompanionCore/Models.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift`
- Modify: `ios/Tests/CompanionCoreTests/HermesSetupTests.swift`
- Modify: `ios/Tests/CompanionCoreTests/HomeActivityPresentationTests.swift`
- Modify: `ios/Tests/CompanionCoreTests/HomeActivityRailLayoutPolicyTests.swift`
- Modify: `ios/Tests/CompanionCoreTests/ModelSelectionPolicyTests.swift`

**Interfaces:**
- Consumes: runtime bindings, endpoint descriptors, capability manifest, and subagent events from Tasks 1–5.
- Produces: global Hermes default, per-bot runtime picker, approved conversion sheet, and upward-only temporary-agent pill.

- [ ] **Step 1: Write failing policy/model tests** for endpoint labels, disabled unavailable capabilities, conversion summary, all-quiet pill absence, upward-only expansion state, completed transcript navigation, and promotion.
- [ ] **Step 2: Run** `swift test --package-path ios --filter Hermes` and the activity-pill test filters; confirm the new cases fail.
- [ ] **Step 3: Implement endpoint selection** as `Computer friendly name / profile`, keep subscription-backed models concise, and persist settings asynchronously before navigation so Back never waits on network I/O.
- [ ] **Step 4: Implement conversion approval UI** showing what changes, what remains, the selected endpoint, and a disclosure for sanitized context handoff.
- [ ] **Step 5: Implement the compact pill.** Hide it when quiet; animate controls upward only; allow text width to grow; navigate to retained temporary-agent transcripts; add `Promote to Bot` when eligible.
- [ ] **Step 6: Run all iOS package tests** with `swift test --package-path ios`, then build the iOS scheme without signing.
- [ ] **Step 7: Commit** `feat(ios): add native Hermes runtime controls`.

## Wave 1 Release Gate

- [ ] Run every focused command above plus `pnpm test`, `pnpm typecheck`, `pnpm build:bridge`, `pnpm build:companion`, `swift test --package-path ios`, and the unsigned iOS build.
- [ ] Verify `git diff --check`, staged secret scan, and a fresh-worktree install/test.
- [ ] Manually verify: existing provider bot unchanged; user-approved V Bot-to-Hermes and Hermes-to-provider rebind; two Hermes profiles on separate bridges; persistent agent projection; temporary MoA transcript and promotion; unavailable capability UI.
- [ ] Review final diff against all security invariants and report base/final commits, exact commands, pass/fail counts, compatibility behavior, and remaining dependencies.

## Wave 2 — Hermes Native-Function Parity

Do not start until Wave 1 is accepted.

### Task 7: Learning, skills, routines, approvals, and sessions

**Files:**
- Create: `server/hermes-native-features.ts`
- Create: `server/hermes-native-features.test.ts`
- Modify: `server/hermes-bridge-integration.ts`
- Modify: `server/approvals.ts`
- Modify: iOS Hermes detail/settings views and tests

- [ ] Add fixture-driven tests for skill creation/refinement, learning events, routine lifecycle, native approvals, session resume, queue/steer, and final responses.
- [ ] Project each native Hermes result into existing V Bot events without mutating Hermes-owned memory or skill storage.
- [ ] Require V Bot approval for persistence, installation, external writes, and autonomous runtime changes.
- [ ] Run server/iOS full gates and commit `feat(hermes): project native learning and tools`.

### Task 8: Native bot-to-bot and group conversations

**Files:**
- Create: `server/hermes-conversation-projection.ts`
- Create: `server/hermes-conversation-projection.test.ts`
- Modify: `server/hermes-groups.ts`
- Modify: iOS chat rendering/navigation files and tests

- [ ] Test Hermes-to-Hermes, Hermes-to-provider, group messages, participant filtering, anchor navigation, unread clearing, and hidden-channel preference.
- [ ] Store one canonical V Bot conversation projection with source event IDs for idempotency.
- [ ] Run full gates and commit `feat(hermes): add native peer conversation projection`.

## Wave 3 — Scoped Fleet and Local VM

Do not start until Wave 2 is accepted.

### Task 9: Hermes computer tools through V Bot leases

**Files:**
- Create: `server/hermes-computer-tools.ts`
- Create: `server/hermes-computer-tools.test.ts`
- Modify: `server/drivers/agents-proxy.ts`
- Modify: `server/bridge-jobs.ts`
- Modify: bridge Local VM execution files and tests

- [ ] Test bot/device scopes, lease expiry, approval, cancellation, unavailable/offline bridges, read-only versus mutating actions, and denial of Docker/socket access.
- [ ] Route Hermes requests through existing V Bot bridge jobs and Local VM leases; never execute directly from the MCP facade.
- [ ] Run full server/bridge gates and commit `feat(hermes): add scoped fleet and VM tools`.

## Wave 4 — Protected Cloudflare Web Client

Do not start until Wave 3 is accepted. Reconcile the existing `feat/vbot-web-mvp` worktree against current `vbot-private/main`; port commits task-by-task rather than blindly merging its stale base.

### Task 10: PocketID Access plus mandatory V Bot pairing

**Files:**
- Modify: `cloudflare/control-plane/src/web-client-auth.ts`
- Modify: `cloudflare/control-plane/src/web-client-auth-exchanges.ts`
- Modify: corresponding Cloudflare tests and D1 migrations
- Modify: web session/client files ported from `feat/vbot-web-mvp`

- [ ] Test valid/invalid Cloudflare Access JWT assertions, PocketID identity mapping, expired one-time exchange, replay, wrong origin, account discovery without pairing, and paired-hub authorization.
- [ ] Trust Access identity only after Worker-side verification; require the existing V Bot device-pairing exchange before issuing a hub session.
- [ ] Run Worker tests, typecheck, build, `wrangler deploy --dry-run`, and secret scan.
- [ ] Commit `feat(web): protect V Bot with PocketID Access`.

### Task 11: Web parity for Hermes and temporary agents

**Files:**
- Modify: web shell, session, streaming, approval, settings, and activity components ported from `feat/vbot-web-mvp`
- Add: colocated Vitest/Testing Library tests

- [ ] Test runtime selection, conversion approval, Hermes capability states, peer conversations, quiet-hidden activity pill, upward expansion, retained temporary transcripts, and promotion.
- [ ] Keep the browser a thin client of the paired hub; do not add a second transcript or fleet store.
- [ ] Run web unit/E2E/build gates and commit `feat(web): add Hermes runtime parity`.

Deployment remains a separate root-owned release task: create Cloudflare resources, configure Access/PocketID, add DNS for `vbot.posival.com`, deploy, and verify the public URL only after explicit production approval.

## Wave 5 — Voice Calls

Do not start until Wave 4 is accepted and Hermes event streaming is stable.

- [ ] Execute `docs/superpowers/plans/2026-09-01-vbot-native-voice-calls.md` task-by-task.
- [ ] Add acceptance coverage for one-on-one Hermes calls, non-Hermes calls, and team calls that follow the V Bot hierarchy and participant roster.
- [ ] Preserve half-duplex, on-device Apple speech recognition, tap-to-interrupt, silence detection, existing chat/SSE/TTS, and Kokoro-next decisions. Do not implement simultaneous barge-in before acoustic echo cancellation.

## Final Program Gate

- [ ] Re-run all server, bridge, iOS, web, Cloudflare, and security gates from clean checkouts.
- [ ] Verify no secret appears in config, logs, argv, fleet metadata, snapshots, transcripts, or error messages.
- [ ] Verify existing provider bots, desktop identities, managed endpoints, and device-pairing contracts remain compatible.
- [ ] Verify Hermes native learning, skills, MoA, routines, approvals, sessions, bot-to-bot, fleet/VM, web, and voice capability states using real endpoints rather than mocked version assumptions.
- [ ] Only the root release owner may merge, deploy, publish artifacts, change DNS, or upload TestFlight.
