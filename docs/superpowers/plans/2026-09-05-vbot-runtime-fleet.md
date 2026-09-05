# V Bot Runtime and Fleet Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve model-agnostic execution while making selected-machine routing, global style compatibility, and approval summaries production-safe and product-neutral.

**Architecture:** Reuse the existing typed bridge/native VM job system and deterministic approval explainer. No new execution channel. Make machine selection fail closed and make reviewer-model selection an internal bounded policy.

**Tech Stack:** TypeScript, Node, bridge daemon, companion, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-vbot-product-readiness-design.md`

## Global Constraints
- A pinned computer never falls back to hub/local execution.
- Existing native relay ownership/takeover/stop/job-generation guards remain.
- Reviewer output cannot alter deterministic risk or approval authority.
- House-style config stays backward compatible.
- No live fleet mutation during implementation tests.

---

### Task 1: Reconcile latest durable bridge lifecycle with native relay
**Files:** inspect/cherry-pick only the relevant bridge lifecycle/trust commits from `cursor/bridge-job-lifecycle-08ea`; resolve in `server/bridge-registry.ts`, `server/bridge-routes.ts`, `bridge/src/*`, associated tests.

- [ ] Compare merge base and commit diffs; write a ledger ruling for every overlapping native-relay file.
- [ ] Add/retain tests for reconnect, generation, cancellation, and native invoke preflight.
- [ ] Integrate only commits whose behavior is compatible with the selected-host contract.
- [ ] Run bridge/server focused suites and built bridge imports.
- [ ] Commit `fix(fleet): reconcile durable bridge jobs with native relay`.

### Task 2: Selected-machine execution contract
**Files:** `server/index.ts`, `server/bridge-local-vm.ts`, target-resolution helpers/tests.

**Interfaces:** A pure resolver returns `{ kind: "hub" | "bridge"; bridgeId?: string; reason?: string }`; explicit hostId requires that exact compatible online bridge or returns blocked. Auto may choose a suitable online bridge according to existing precedence.

- [ ] Add RED tests for pinned Windows while hub has Docker, pinned offline, permission revoked, and Auto.
- [ ] Implement/refactor only as needed; preserve already-proven native relay.
- [ ] Run HTTP ownership/host routing tests.
- [ ] Commit `fix(fleet): enforce selected computer routing`.

### Task 3: Product-neutral global style compatibility
**Files:** `server/house-style.ts`, `server/config.ts`, companion safe projection/routes, tests.

**Interfaces:** Storage remains `houseStyle` for migration compatibility; public/safe projections may expose `globalStyle` alias while accepting legacy route. Internal default remains a fallback, not a public named feature.

- [ ] Add RED tests for legacy config load, global-style projection, disabled state, per-bot opt-out.
- [ ] Implement compatibility alias without duplicating prompt blocks.
- [ ] Run config/house-style/companion tests.
- [ ] Commit `refactor(style): expose global style without breaking legacy config`.

### Task 4: Automatic approval-summary reviewer policy
**Files:** `server/approval-explainer.ts`, reviewer wiring in `server/index.ts`, config/policy tests.

**Interfaces:** User mode stays off/when-unclear/always. If configured provider/model remains valid, preserve it. Otherwise choose an available fast low-cost model using advertised catalogs, preferring Luna/Haiku/Flash-class models without crossing into a different authority path. Timeout and deterministic fallback remain.

- [ ] Add RED tests for preserved explicit reviewer, automatic fallback, unavailable catalogs, timeout, malformed model output.
- [ ] Implement internal selection policy; never persist an automatic choice unless existing config semantics require it.
- [ ] Run reviewer and approval suites.
- [ ] Commit `feat(approvals): auto-select tool summary reviewer`.

### Task 5: Runtime gate
- [ ] Run focused server/bridge/companion tests, typechecks, server+bridge+companion builds, built bridge imports.
- [ ] Run full test floor. Isolate any unrelated flake rather than changing timing without evidence.
- [ ] Record exact live deployment preconditions; do not deploy until iOS/web integration is reviewed.
