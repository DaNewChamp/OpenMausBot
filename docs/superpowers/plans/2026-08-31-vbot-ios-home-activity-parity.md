# V Bot iOS Home and Activity Parity Plan

**Goal:** Close the remaining visible iOS gaps with an original, clean-room Grok Bot-class home surface while preserving V Bot's model-agnostic, Hub-first architecture.

**Architecture:** The Hub remains authoritative for bots, transcripts, approvals, queues, and work metadata. iOS derives presentation-only summaries from existing paired data. Bridges remain capability-advertising execution endpoints. No provider credentials, provider-specific state, or new backend dependency moves into the phone.

**Tech stack:** Swift 6, SwiftUI, CompanionCore, existing HTTP/SSE contracts, zero new dependencies.

## Global constraints

- Use original V Bot code and assets; reproduce visual proportions and interaction behavior only.
- Preserve the current bundle ID, pairing identity, headless Hub, loopback harness, and bridge approval boundaries.
- Keep provider names out of generic work-state and PR-card policy.
- Do not invent unsupported remote routes. Optional work-card fields must fail closed and degrade to ordinary transcript content.
- Respect Dynamic Type, VoiceOver, Reduce Motion, and minimum 44-point hit targets.
- Tests first for every policy or behavior change; commit each task separately.
- Do not add, remove, or upgrade dependencies.
- Do not deploy backend infrastructure or modify production networking.

## Task 1: Reference-scale home chrome and connection halo

**Files:**
- Modify: `ios/Sources/CompanionCore/HomeRosterLayoutPolicy.swift`
- Modify: `ios/Sources/CompanionCore/ConnectionResiliencePolicy.swift`
- Modify: `ios/Tests/CompanionCoreTests/HomeRosterLayoutPolicyTests.swift`
- Modify: `ios/Tests/CompanionCoreTests/ConnectionResiliencePolicyTests.swift`
- Modify: `ios/App/ChatListView.swift`
- Modify: `ios/App/PinnedChatShelf.swift`

**Requirements:**
- Render account avatar at 36 points inside a 44-point hit target.
- Render search and add controls as 44-point circles with 17-point symbols and an 8-point gap.
- Render the single-pin hero at 20% of pane width (about 80 points at 402 points), retaining the existing caption breathing room and clipping protections.
- Replace only the initial textual `Connecting...` roster banner with a subtle rotating halo around the account avatar.
- Keep reconnecting, offline, and unauthorized banners visible because they convey actionable state.
- Reduce Motion uses a static halo. VoiceOver announces the connection state without exposing route details.

**TDD:** Add failing metric and projection tests, run them red, implement the policy/UI, then run focused and full Swift tests.

**Commit:** `fix(ios): refine home chrome and connection feedback`

## Task 2: Premium bottom activity pill

**Files:**
- Create: `ios/Sources/CompanionCore/HomeActivityPresentation.swift`
- Create: `ios/Tests/CompanionCoreTests/HomeActivityPresentationTests.swift`
- Create: `ios/App/HomeActivityPill.swift`
- Modify: `ios/App/Updates.swift`
- Modify: `ios/App/UpdatesSheet.swift`
- Modify: `ios/App/ChatListView.swift`

**Requirements:**
- Derive one provider-neutral summary with states `quiet`, `active`, and `needsAttention`.
- Expanded groups are `Needs you`, `Active`, `Queued`, and `Recently finished` in that order.
- Approvals outrank active work; active work outranks queued work; newly finished unread work remains reviewable.
- Collapsed idle copy is `All quiet` / `Nothing needs you`.
- Collapsed active copy reports a count without naming a provider.
- The pill is compact, bottom-safe-area aware, and expands upward in place; it must not cover roster rows or compete with the top needs-you island.
- Tapping an item opens its existing chat. Reduce Motion uses opacity only; VoiceOver exposes state and count.
- Use only existing CompanionState, pending approvals, busy state, unread state, and locally known queue receipts. Do not synthesize global queue truth the Hub did not send.

**TDD:** Add failing reducer/order/copy tests, run red, implement the core projection and SwiftUI surface, then run focused and full Swift tests.

**Commit:** `feat(ios): add premium home activity pill`

## Task 3: Provider-agnostic work and PR cards

**Files:**
- Create: `ios/Sources/CompanionCore/WorkCardPresentation.swift`
- Create: `ios/Tests/CompanionCoreTests/WorkCardPresentationTests.swift`
- Modify: `ios/Sources/CompanionCore/Models.swift`
- Modify: `ios/App/Cards/GitPRDiffCardView.swift`
- Modify: `ios/App/ChatView.swift`

**Requirements:**
- Decode optional work metadata without changing ordinary messages: title, status, branch, PR number, files changed, additions, deletions, HTTPS PR URL, and optional Cursor deep link.
- Show `View PR` only for a valid HTTPS URL.
- Show `Open in Cursor` only when a valid Cursor deep link exists and iOS reports that the scheme can open.
- Never infer a PR URL, repository, provider, or Cursor availability.
- Invalid or missing metadata degrades to the existing diff card or ordinary message.
- Buttons use 44-point targets and explicit accessibility labels.

**TDD:** Add failing decoding, URL validation, action-gating, and graceful-degradation tests, run red, implement minimal model/policy/UI, then run focused and full Swift tests.

**Commit:** `feat(ios): add provider-neutral work cards`

## Task 4: Integrated visual and release gate

**Files:**
- Modify: `ios/TESTING.md`
- Modify: `ios/AppStore/en-US/release_notes.txt`

**Requirements:**
- Run `swift test --package-path ios`.
- Generate the isolated Xcode project from `ios/project.yml`.
- Build unsigned Debug and Release for an available iPhone simulator.
- Capture the home in quiet, initial-connecting, active, needs-approval, and expanded-pill states; inspect at normal and large Dynamic Type with Reduce Motion on and off.
- Capture a work card with and without optional actions.
- Review the complete branch diff and fix all Critical or Important findings.
- Push the private feature branch.
- Upload TestFlight only under the user's separately confirmed release authorization, after checking the next available build number and completing the signing/export gate.

**Commit:** `docs(ios): record home parity release evidence`
