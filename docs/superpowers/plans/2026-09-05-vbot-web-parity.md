# V Bot Web Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the hosted web app so it presents the same fleet, model, style, approval, call, room, routine, and connected-app concepts as iOS.

**Architecture:** Integrate the verified `feat/vbot-web-polish-0904` behavior onto the readiness branch, then normalize copy/components around shared server contracts. Do not fork backend semantics for web.

**Tech Stack:** React 19, TypeScript, Vite, existing paired hub APIs.

**Spec:** `docs/superpowers/specs/2026-09-05-vbot-product-readiness-design.md`

## Global Constraints
- Keep hosted browser paired to the authoritative hub.
- Use the same model/fleet/style/approval semantics as iOS.
- Remove normal-user House Style and Execution bridge terminology.
- Preserve responsive behavior from the existing polished branch.
- No provider secrets in browser state.

---

### Task 1: Integrate existing verified web-polish commits
**Files:** merge/cherry-pick behavioral commits `8727841`, `5ea1e640`, `5d528c53`, `2147024b`, `c8908070` plus required tests; omit superseded docs-only commits unless still accurate.

- [ ] Compare each commit against readiness HEAD and record conflicts.
- [ ] Cherry-pick one at a time, resolving against the current native-relay/mobile contracts.
- [ ] Run affected Vitest suites after each behavioral commit.
- [ ] Commit conflict resolutions only when needed.

### Task 2: Fleet terminology and computer settings
**Files:** `src/components/SettingsModal.tsx`, computer/fleet components and presentation helpers/tests.

- [ ] Add RED UI/presentation tests requiring Hub, Available computers, Auto/Specific/Isolated VM, and banning normal `Execution bridge` copy.
- [ ] Implement shared fleet terminology and concise online/offline state.
- [ ] Run focused web tests.
- [ ] Commit `fix(web): align hub and fleet terminology`.

### Task 3: Style and approval settings parity
**Files:** `src/components/SettingsModal.tsx`, `src/components/HouseStyleSettings.tsx` renamed/reworked as `GlobalStyleSettings.tsx`, approval reviewer settings/tests.

- [ ] Add RED tests banning House Style and reviewer provider/model controls in normal settings.
- [ ] Present Global style and Explain tool requests mode only; preserve backend fields.
- [ ] Keep raw/advanced diagnostics out of the default settings page.
- [ ] Run focused tests.
- [ ] Commit `feat(web): simplify global style and tool explanations`.

### Task 4: Approval card and model/fleet parity
**Files:** chat approval components, model picker/settings components, tests.

- [ ] Add tests for plain-language approval summary + expandable raw details.
- [ ] Ensure compact model family picker semantics match iOS: browse without save, explicit apply, separate same-model Fast/context/reasoning/source controls when supported.
- [ ] Run frontend tests/typecheck/build.
- [ ] Commit `feat(web): align agent controls with iOS`.

### Task 5: Responsive hosted-web acceptance
- [ ] Run frontend suite, `tsc -b`, Vite build, and existing five-width QA at 1440/1024/768/390/320.
- [ ] Verify calls, rooms, routines, Connected apps, Computer, settings, and model picker on the hosted build.
- [ ] Deploy only the required web/runtime artifacts after idle-bot/job checks and backups.
- [ ] Verify `https://vbot.posival.com` and hub health, exact deployed bundle hash, mobile/desktop screenshots, and no horizontal overflow.
- [ ] Commit release handoff with exact evidence.
