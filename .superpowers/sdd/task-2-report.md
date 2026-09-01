# Task 2 implementation report

Date: 2026-09-01 (America/Chicago)
Branch: `feat/vbot-hermes-adapter-0901`
Executing lane: Luna max (`gpt-5.6-luna`)

## Status

Implemented the safe same-host Hermes setup API. The authenticated companion
sidecar now exposes exact status and connect/import routes. The hub enables the
existing opt-in Hermes registry, reloads the provider fleet when enabling it,
rediscovers one validated profile, adopts or creates the exact hidden
`Bot Chat`, creates or reuses one V Bot bot, and persists only the existing
minimal binding. Calls are serialized per registry/profile path and repeat
calls reuse the same bot.

## Files changed

- `server/hermes-setup.ts`
  - Added safe setup status projection and idempotent profile connect/import
    transaction.
  - Validates profile slugs, binding shape, discovered profile identity,
    existing bot ownership, and stale/duplicate sidecars.
  - Uses the existing `loadHermesBindings`/`setHermesBinding`/
    `removeHermesBinding` store and rolls back a newly-created bot on every
    failed publication/verification path.
  - Returns only state, bounded profile display fields, V Bot bot id, and
    capability flags.
- `server/hermes-setup.test.ts`
  - Added disabled/unavailable projection, binding validation, idempotency,
    concurrent-connect serialization, and binding-write rollback coverage.
- `server/engines/hermes.ts`
  - Added setup-only `ensureCanonical` adopt-before-mint behavior under the
    existing profile lock.
  - Uses exact `session.list` semantics, creates only with
    `{ profile, title: "Bot Chat", hidden: true, source: "tui" }`, requires a
    durable create id, re-resolves after creation, and never retries a second
    title. Existing canonical rows are hidden when needed with `session.set_hidden`.
- `server/engines/hermes-adapter.test.ts`
  - Added adopt-before-mint, durable-id fail-closed, and exact-RPC assertions.
- `server/index.ts`
  - Added direct loopback `GET /api/hermes/setup` and
    `GET /api/hermes/setup/status`, plus `POST /api/hermes/setup`,
    `POST /api/hermes/setup/connect`, and `POST /api/hermes/connect`.
  - Enables/reloads only the configured Hermes instance; custom fleets that do
    not name a Hermes instance fail closed instead of creating a shadow or
    falling through to generic ACP.
- `server/index.hermes-adapter.test.ts`
  - Added live hub fixture coverage for safe status, import/repeat,
    sidecar-minimality, disable/re-enable, and response redaction.
- `companion/src/routes.ts`, `companion/src/proxy.ts`
  - Added default-deny, bearer-authenticated setup route classifiers and
    profile-only JSON validation before forwarding.
- `companion/test/routes.test.ts`, `companion/test/proxy.test.ts`
  - Added exact route/auth/body/content-type and redaction coverage.

## TDD and verification

Focused tests:

```text
./node_modules/.bin/vitest run server/hermes-setup.test.ts server/engines/hermes-adapter.test.ts server/index.hermes-adapter.test.ts companion/test/routes.test.ts companion/test/proxy.test.ts
```

Passed: 5 test files, 175 tests, 0 failures.

Typechecks and whitespace:

```text
./node_modules/.bin/tsc -p tsconfig.server.json --noEmit
./node_modules/.bin/tsc -p tsconfig.companion.build.json --noEmit
git diff --check
```

All passed.

The workspace `pnpm-workspace.yaml` contains unrelated pre-existing
`core-js`/`workerd` `allowBuilds` edits from another task. It was preserved and
is intentionally excluded from this commit; no dependency or workspace setup
was changed here. The Wave 2 plan also requires direct `node_modules` binaries
rather than `pnpm` in this worktree.

## Security self-review

- Companion setup routes are default-deny and require the existing paired
  bearer authentication; the hub remains loopback/origin gated.
- Request bodies accept only an optional bounded profile slug. Credentials,
  paths, environment values, prompts, runtime/session ids, JSON-RPC frames, and
  raw stderr are neither accepted nor returned.
- Responses are a fixed safe projection. Binding persistence remains exactly
  `{ adapter, profile, canonicalTitle, bindingVersion }`.
- Custom instance maps are authoritative. Missing/non-Hermes selected entries
  return a typed setup failure; no generic provider or shadow Hermes instance
  is substituted.
- Canonical creation is adopt-before-mint under the per-profile lock, requires
  a durable id, verifies by exact post-create lookup, and never creates a
  second chat after an unknown/malformed relookup.
- Newly created V Bot bots are deleted and any partial binding is removed when
  binding publication or verification fails. Existing bindings must point to a
  real bot and duplicate/stale profiles fail closed.
- Enable/reload mutates only the opt-in Hermes metadata and configured Hermes
  instance flag; no provider credentials or secrets are written.

## Concerns and root verification

- No real Hermes account, credential store, or live gateway was exercised;
  gateway behavior is covered by injected/fake loopback fixtures.
- The unrelated dirty `pnpm-workspace.yaml` must remain out of the Task 2
  commit and be reconciled by root with the other task owner.
- Root should independently inspect the staged diff, rerun the focused tests
  and both typechecks, and confirm the final commit contains only Task 2 files
  plus this report. No deployment, iOS UI, remote Hermes bridge, dependency,
  signing, or TestFlight work was performed.

## Review-fix pass (2026-09-01)

The review fixes close the two important state-transaction gaps and the
validator/status minor findings without adding a provider RPC:

- `Store.createBot` now snapshots the prior in-memory bot list and durable
  `bots.json` bytes/mode, and restores both when `saveBots()` throws, including
  a simulated post-publication failure. A rejected create therefore cannot
  leave a bot visible in memory but absent after restart.
- Hermes canonical creation now uses an adapter-owned `hermes-pending.json`
  marker. The marker contains only normalized profile slugs (no secret,
  durable session id, or runtime id), is written with the existing locked
  atomic-sidecar discipline, and is retained whenever `session.create`
  succeeds but exact re-lookup is absent/unknown/malformed or otherwise
  unverified. Retries re-check the exact title and fail closed while the marker
  remains; they cannot mint a second hidden `Bot Chat`. A present row adopts
  and clears the marker. The pinned gateway method table exposes no
  `session.delete`/cleanup method, so no unsupported RPC was invented.
- Created-session responses require the exact top-level `session_id` field
  with strict opaque-id validation; aliases, nested ids, empty values, and
  whitespace-padded values are rejected.
- Hub discovery, setup, bindings, and the companion request validator reject
  the same reserved `session`/`root-session`/`resolved-session` forms and
  UUID/hex-shaped profile slugs.
- Setup status no longer infers `canonicalChat` from a V Bot binding alone;
  the affirmative capability and profile state require a current discovered
  canonical row. The connect path may still affirm it only after the adapter's
  exact live post-create/adoption proof.

### Review-fix verification (exact)

```text
./node_modules/.bin/vitest run server/hermes-setup.test.ts server/engines/hermes-adapter.test.ts server/index.hermes-adapter.test.ts companion/test/routes.test.ts companion/test/proxy.test.ts
```

Passed: 5 test files, 180 tests, 0 failures (17:02:19, 5.11s).

Additional focused regressions:

```text
./node_modules/.bin/vitest run server/store.test.ts server/engines/bindings.test.ts server/engines/discovery.test.ts server/engines/hermes-adapter.test.ts
```

Passed: 4 test files, 164 tests, 0 failures (17:02:30, 2.16s).

```text
./node_modules/.bin/tsc -p tsconfig.server.json --noEmit
./node_modules/.bin/tsc -p tsconfig.companion.build.json --noEmit
git diff --check
```

All passed (17:02:34). No dependency, deployment, remote bridge, iOS, or
credential operation was performed.

### Security rationale and residual concerns

- The pending sidecar is profile-only, mode `0600`, parent `0700`, protected
  by the same owner/symlink/lock/atomic checks as the existing binding sidecar.
  It intentionally never stores provider ids, runtime handles, prompts, or
  credentials. Operators must clear a marker only after confirming the
  provider row is absent; automatic clearing is limited to an exact current
  canonical match.
- Because the pinned gateway has no proven delete method, a lost create
  response can leave an unseen provider row. The durable marker prevents
  duplicate creation and forces an explicit operator/provider reconciliation;
  this is safer than retry minting or guessing an RPC.
- No real Hermes account or gateway was exercised; injected loopback fixtures
  cover the create/lookup failure matrix. The pre-existing dirty
  `pnpm-workspace.yaml` remains outside this change and must not be included
  when the root orchestrator reconciles commits.
