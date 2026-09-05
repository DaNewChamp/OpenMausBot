# V Bot iOS Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Local VM keyboard/viewer defects and make mobile fleet, style, and approval UX match the approved product model.

**Architecture:** Keep the phone a paired thin client. Add small presentation policies for fleet count/naming and approval settings, keep VM input on existing guarded routes, and change focus/view selection rather than adding a second transport.

**Tech Stack:** SwiftUI, CompanionCore, existing paired companion APIs.

**Spec:** `docs/superpowers/specs/2026-09-05-vbot-product-readiness-design.md`

## Global Constraints
- Do not broaden phone permissions or expose secrets.
- Local VM keyboard dismissal must work without relying on an obscured control.
- Fleet Local VM must retain screenshot/CDP fallback when a live viewer is unavailable.
- Normal UI must not say House Style or Execution bridge.
- Approval model/provider selection is not end-user configuration.
- Use TDD and commit each task independently.

---

### Task 1: VM keyboard focus and dismissal
**Files:** Modify `ios/App/ComputerView.swift`, `ios/App/VmKeyboardBar.swift`, `ios/App/LocalVmInteractionChrome.swift`; create/modify focused policy/view tests under `ios/Tests`.

**Interfaces:** `VmKeyboardBar` gains an explicit `onDismiss: () -> Void`. `ComputerView` owns one `dismissVmKeyboard()` path used by Done, keyboard toggle, navigation/back lifecycle, and destination changes.

- [ ] Add a failing test around a small keyboard-presentation policy proving active keyboard transitions to inactive on dismiss/back/destination change.
- [ ] Run the focused Swift test and confirm RED.
- [ ] Implement the single dismissal path and visible Done affordance above the keyboard. Do not add a second text field.
- [ ] Run focused tests GREEN and `swift test`.
- [ ] Commit `fix(ios): make VM keyboard always dismissible`.

### Task 2: Reliable Local VM desktop surface
**Files:** Modify `ios/App/ComputerView.swift`, `ios/Sources/CompanionCore/ComputerPresentationState.swift`; tests in `ios/Tests`.

**Interfaces:** Add a pure presentation decision that chooses `.interactivePreview` for a fleet Local VM when guarded input plus frames are available, even if the optional full viewer failed. `.liveViewer` is reserved for backends whose safe projection explicitly advertises it.

- [ ] Write failing tests for viewer failure + usable VM screenshot/CDP => interactive preview, and true Box/live-viewer backend => live viewer.
- [ ] Run RED.
- [ ] Implement the policy and replace blank-viewer fallback with screenshot/CDP interaction plus Retry for frame refresh.
- [ ] Run focused tests, full Swift tests, simulator build.
- [ ] Commit `fix(ios): prefer reliable fleet VM preview`.

### Task 3: Hub and fleet terminology
**Files:** Modify `ios/App/SettingsView.swift`; add/modify `ConnectionPresentationPolicy`/`BridgePresentationPolicy` tests in CompanionCore.

**Interfaces:** Produce `computerSummary(hubCount:connectedComputerCount:)` yielding `1 hub · 2 connected computers`; sections are `Hub` and `Available computers`; bridge role/capability jargon only appears in Advanced/diagnostic copy.

- [ ] Add RED presentation-policy tests for 1 hub + 2 online computers and stale/offline nodes.
- [ ] Implement copy/count policy and update Settings/Computers views.
- [ ] Run GREEN Swift suite.
- [ ] Commit `fix(ios): clarify hub and fleet computers`.

### Task 4: Global style and approval explanation simplification
**Files:** Modify `ios/App/SettingsView.swift`, `ios/App/AgentProfileView.swift`, `ios/Sources/CompanionCore/ApprovalReviewerModelPolicy.swift`; tests under `ios/Tests`.

**Interfaces:** Normal Settings exposes `Global style` (optional user text) and `Explain tool requests` mode only. Hide reviewer provider/model controls. Per-bot profile retains its own instruction/personality field and states whether global style applies.

- [ ] Add RED tests proving public copy has no `House style`, provider, or model picker for approval explanation.
- [ ] Implement Global style copy using existing config route and simplify approval reviewer to mode only.
- [ ] Keep provider/model state preserved on writes so simplifying the UI does not erase an existing configured reviewer.
- [ ] Run Swift suite and simulator build.
- [ ] Commit `feat(ios): simplify style and tool explanations`.

### Task 5: Tool approval card readability
**Files:** Modify approval-card portion of `ios/App/ChatView.swift`; add pure presentation helper/test in CompanionCore if needed.

**Interfaces:** Card headline expresses actor/action/host; second line states change/no-change; Details reveals raw tool/command/scope. Existing approve/deny/grant controls and deterministic risk remain unchanged.

- [ ] Write RED snapshot/presentation tests for read-only git status and destructive command examples.
- [ ] Implement compact primary copy and disclosure Details.
- [ ] Run Swift tests and simulator build.
- [ ] Commit `feat(ios): make tool approvals readable`.

### Task 6: iOS release acceptance
**Files:** Update `docs/ios-companion.md` and release handoff.

- [ ] Run full Swift tests, generate Xcode project, simulator build/run.
- [ ] On physical iPhone, verify Computer keyboard show/type/dismiss/reopen; trackpad/touch remain usable; blank viewer cannot trap the session.
- [ ] Verify Settings count matches one hub plus connected fleet computers and House Style is absent.
- [ ] Archive only after prior gates pass; bump build once based on current App Store Connect maximum.
- [ ] Commit release docs with exact evidence.
