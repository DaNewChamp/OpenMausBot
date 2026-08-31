# V Bot iOS Parity Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining clean-room iOS work needed for V Bot to feel like a complete, model-agnostic Grok Bot-class client while keeping a headless Hub primary, lightweight machine Bridges, and desktop optional.

**Architecture:** One Hub owns bots, transcripts, approvals, routines, goals, devices, and engine routing. The iOS app is the premium thin client. Bridges advertise explicit, revocable capabilities from additional machines. The optional desktop app packages Hub + local Bridge + setup and provides a larger control surface for users whose only machine is a Mac or PC; it is not a protocol dependency.

**Tech Stack:** Swift 6 / SwiftUI / CompanionCore, Node 24 / TypeScript harness and companion sidecar, HTTP + SSE, existing provider CLIs and OAuth sessions, zero new dependencies.

## Global Constraints

- Clean-room behavior and original V Bot assets only; do not copy proprietary code, private routes, or bundled assets from Grok Bot.
- The Hub remains the source of truth; iOS and desktop clients do not fork bot or transcript state.
- Harness stays loopback-only; phone access stays behind the paired, allowlisted companion.
- Existing user OAuth sessions and configured providers may be reused server-side, but credentials and tokens never move to the phone or another machine.
- Unsupported engine capabilities must be hidden or disabled with plain-language copy; never guess undocumented reconstructed routes.
- Machine actions require explicit advertised capabilities and the existing approval boundary.
- Preserve `com.posival.openmausmobile`, existing pairing identities, and legacy OpenMausBot data-path compatibility.
- Do not add, remove, or upgrade dependencies.
- Do not deploy, alter networking, or upload TestFlight in this plan without Vincent's explicit approval.
- Keep the private `vbot-private/main` branch updated only after each task passes implementation and review gates.

---

### Task 1: Capability-Honest Composer and Engine Switching

**Files:**
- Modify: `ios/Sources/CompanionCore/ComposerActionPolicy.swift`
- Modify: `ios/Sources/CompanionCore/EngineSyncPolicy.swift`
- Modify: `ios/App/ChatComposerView.swift`
- Modify: `ios/App/ChatView.swift`
- Modify: `ios/App/Session.swift`
- Modify: `ios/App/SettingsView.swift`
- Modify: `server/vbot-engine-sync.ts`
- Modify: `server/index.ts`
- Test: `ios/Tests/CompanionCoreTests/ComposerActionPolicyTests.swift`
- Test: `ios/Tests/CompanionCoreTests/EngineSyncTests.swift`
- Test: `server/vbot-engine-sync.test.ts`
- Test: `server/index.test.ts`

**Interfaces:**
- Consumes: the server-advertised engine capability flags and current aggregate busy state.
- Produces: `ComposerCapabilityPolicy` decisions for attachments and a busy-safe primary-engine transition contract.

- [ ] **Step 1: Add failing capability-policy tests**

Cover a capable engine, an attachments-disabled engine, preserved text/draft behavior, and a busy engine switch. An unsupported attachment selection must never upload or send attachment markup. A busy primary-engine switch must return a conflict without mutating the saved engine.

- [ ] **Step 2: Run the focused tests and confirm behavioral failures**

Run the two Swift policy suites and the two server suites. Expected: the new cases fail because composer attachment availability and primary-engine busy rejection are not yet enforced.

- [ ] **Step 3: Implement the minimal capability and transition policies**

Add one CompanionCore policy that returns whether Photos, camera, files, and attachment submission are available from the selected engine capabilities. Hide unsupported picker entries and show one plain-language explanation if an already-staged attachment becomes unsupported. Add a server-side busy guard for primary-engine changes and mirror it in iOS. Stop/steer routing must remain attached to the engine that originated the active turn.

- [ ] **Step 4: Run focused tests, Swift tests, typecheck, and simulator build**

Expected: focused cases pass, `swift test --package-path ios` passes, `pnpm typecheck` passes, and the unsigned simulator Debug build succeeds.

- [ ] **Step 5: Commit**

Commit message: `fix(ios): respect engine capabilities while working`

---

### Task 2: Canonical Reconstructed Roster and Transcript Continuity

**Files:**
- Modify: `server/drivers/grok-reconstructed.ts`
- Modify: `server/vbot-engine-sync.ts`
- Modify: `server/index.ts`
- Modify: `server/store.ts`
- Modify: `companion/src/routes.ts`
- Modify: `ios/Sources/CompanionCore/Store.swift`
- Modify: `ios/App/Session.swift`
- Test: `server/drivers/grok-reconstructed.test.ts`
- Test: `server/vbot-engine-sync.test.ts`
- Test: `server/index.test.ts`
- Test: `companion/test/routes.test.ts`
- Test: `ios/Tests/CompanionCoreTests/StoreTests.swift`
- Test: `ios/Tests/CompanionCoreTests/EventStreamTests.swift`

**Interfaces:**
- Consumes: documented reconstructed `listAgents`, `sendPrompt`, and transcript-tail operations only.
- Produces: stable Hub-owned bot identities, provider-instance metadata, persisted transcript folds, and reconnect-safe polling/event cursors.

- [ ] **Step 1: Add failing identity, transcript, and reconnect tests**

Prove stable reconstructed bot IDs across refreshes, one persisted settled reply per upstream item, no duplicate tail after restart, and `providerInstanceId` on synthetic lifecycle events. Reconstructed groups remain explicitly unsupported until the adapter has documented group semantics.

- [ ] **Step 2: Run focused tests and confirm behavioral failures**

Expected: new cases fail on missing metadata, missing persistence, or duplicate-tail behavior—not on fixture setup.

- [ ] **Step 3: Implement polling-based canonicalization**

Persist the last accepted reconstructed transcript item/cursor in Hub state. Convert documented transcript-tail results into normal store messages and SSE events. Never invent an upstream `/events` route. Keep the companion surface narrow and scrubbed.

- [ ] **Step 4: Run focused server/companion/Swift suites and typecheck**

Expected: all named suites and `pnpm typecheck` pass.

- [ ] **Step 5: Commit**

Commit message: `feat(runtime): persist reconstructed conversations`

---

### Task 3: Grok-Class Home Organization and Ecosystem Topology

**Files:**
- Modify: `ios/Sources/CompanionCore/Models.swift`
- Modify: `ios/Sources/CompanionCore/HomeRosterLayoutPolicy.swift`
- Modify: `ios/App/ChatListView.swift`
- Modify: `ios/App/SettingsView.swift`
- Modify: `docs/v-bot-architecture.md`
- Modify: `docs/ios-companion.md`
- Test: `ios/Tests/CompanionCoreTests/HomeRosterLayoutPolicyTests.swift`
- Test: `ios/Tests/CompanionCoreTests/ModelClientTests.swift`

**Interfaces:**
- Consumes: existing bot/room `section` labels and paired-computer/Bridge capability status.
- Produces: sectioned roster presentation and an explicit Hub / Client / Bridge / Optional Desktop topology in UI copy and documentation.

- [ ] **Step 1: Add failing roster-policy tests**

Cover stable section order, unsectioned fallback, pinned chats remaining above sections, hidden chats excluded, and search flattening across sections. Add copy assertions that distinguish the current Hub from connected execution machines.

- [ ] **Step 2: Run focused tests and confirm failures**

Expected: section-aware layout cases fail because the current iOS roster is flat.

- [ ] **Step 3: Implement sectioned home and topology copy**

Render quiet section labels without changing Grok-proportioned row geometry. Search remains a single ranked result list. Settings explains: Hub stores everything; Bridges add machine abilities; Desktop is optional and can bundle Hub + local Bridge for a one-machine user.

- [ ] **Step 4: Run Swift tests and simulator build**

Expected: all Swift tests pass and the unsigned simulator Debug build succeeds.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): organize bots by team and machine`

---

### Task 4: Team Goals and Routine Timeline

**Files:**
- Modify: `server/group-goal-run.ts`
- Modify: `server/index.ts`
- Modify: `server/store.ts`
- Modify: `server/drivers/agents-proxy.ts`
- Modify: `companion/src/routes.ts`
- Modify: `ios/Sources/CompanionCore/Models.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift`
- Modify: `ios/App/GroupProfileView.swift`
- Modify: `ios/App/TasksRoutinesView.swift`
- Test: `server/group-goal-run.test.ts`
- Test: `server/index.test.ts`
- Test: `server/drivers/agents-proxy.test.ts`
- Test: `companion/test/routes.test.ts`
- Test: `ios/Tests/CompanionCoreTests/GroupRoutingTests.swift`
- Test: `ios/Tests/CompanionCoreTests/RoutinePolicyTests.swift`

**Interfaces:**
- Consumes: the existing bounded group-goal parser/helpers, room membership, delegation depth limit, routine definitions, and routine runs.
- Produces: persisted bounded goal runs with `running`, `needsHuman`, `blocked`, `completed`, and `cancelled` states plus an iOS goal card and chronological routine timeline.

- [ ] **Step 1: Add failing state-machine and route tests**

Cover coordinator selection, one-hop worker assignment, duplicate-assignment suppression, human-input pause, completion, cancellation, persistence/restart, companion allowlisting, and routine ordering by next/run time.

- [ ] **Step 2: Run focused tests and confirm failures**

Expected: tests fail because helpers exist but the persisted orchestration and paired-phone routes are not wired.

- [ ] **Step 3: Implement bounded orchestration and iOS surfaces**

Wire the existing control-envelope parser into a Hub-owned state machine. Never recursively delegate beyond one hop. Group profile gets `Start team goal`; the transcript gets one compact goal-progress card. Routines display upcoming and recent work as a clean chronological timeline using existing CRUD/run APIs.

- [ ] **Step 4: Run focused suites, full Swift tests, typecheck, and simulator build**

Expected: all named suites pass, `pnpm typecheck` passes, and simulator Debug succeeds.

- [ ] **Step 5: Commit**

Commit message: `feat(teams): add bounded goals and routine timeline`

---

### Task 5: Native iOS Call Mode

**Files:**
- Create: `ios/App/CallModeView.swift`
- Create: `ios/Sources/CompanionCore/CallModePolicy.swift`
- Modify: `ios/App/ChatChromeView.swift`
- Modify: `ios/App/SpeechDictation.swift`
- Modify: `ios/App/Session.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift`
- Modify: `companion/src/routes.ts`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`
- Test: `ios/Tests/CompanionCoreTests/VoiceClientTests.swift`
- Test: `companion/test/routes.test.ts`

**Interfaces:**
- Consumes: existing iOS speech recognition, `/api/tts/prepare`, `/api/tts/speak`, bot voice readiness, settled replies, activity narration, and approval cards.
- Produces: an explicit half-duplex iOS call state machine: `idle`, `listening`, `sending`, `waiting`, `speaking`, `needsApproval`, `ended`.

- [ ] **Step 1: Add failing call-state tests**

Cover microphone closed during playback, silence-finalized user turns, tap-to-interrupt, approval yes/no only, no room calls, no call button without a ready voice, and call teardown when leaving chat.

- [ ] **Step 2: Run focused tests and confirm failures**

Expected: tests fail because iOS currently has composer dictation but no call-mode state machine.

- [ ] **Step 3: Implement the minimal half-duplex call UI**

Use the existing server-side speech-text preparation and synthesis routes. Do not add realtime providers, full-duplex audio, or new credentials. Display an original V Bot call surface with avatar, live phase, transcript excerpt, mute/end controls, and approval actions.

- [ ] **Step 4: Run focused tests, full Swift tests, and simulator build**

Expected: all tests pass and simulator Debug succeeds. Physical microphone/audio quality remains a documented device gate.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add half-duplex bot calls`

---

### Task 6: Final Integrated Review and Evidence Update

**Files:**
- Modify: `docs/VBOT_PREMIUM_PLAN.md`
- Modify: `docs/handoff-phased-plan.md`
- Modify: `ios/TESTING.md`
- Modify: `ios/AppStore/en-US/release_notes.txt`

**Interfaces:**
- Consumes: Tasks 1–5 and their verified commits.
- Produces: current architecture/status documentation and a future-build release note without changing the build number or uploading TestFlight.

- [ ] **Step 1: Run the complete automated gate**

Run `pnpm typecheck`, `pnpm build`, `node scripts/test-floor.mjs`, focused Node release tests, `swift test --package-path ios`, XcodeGen, and unsigned iOS Debug/Release simulator builds. Record exact results.

- [ ] **Step 2: Run an accessibility and performance static/simulator pass**

Verify Dynamic Type layouts, reduce-motion branches, VoiceOver labels for new controls, a 500-message transcript fixture, and no raw tool/provider secrets in rendered error text. Physical-device FPS, microphone, cellular VM, and push remain explicit gates if no device is attached.

- [ ] **Step 3: Update the current-state documents**

Replace stale build-62/old-HEAD claims with the verified current commit and distinguish automated, simulator, live-hub, and physical-device evidence.

- [ ] **Step 4: Final whole-branch review**

Review the full range from `a96ef3d` through the final commit for spec compliance, security boundaries, regressions, and unsupported claims. Fix all Critical and Important findings and re-review.

- [ ] **Step 5: Commit and push without releasing**

Commit message: `docs(vbot): close iOS parity implementation wave`

