# Task 1 implementation report

Commit: task-sized `feat(vbot): add Hermes Bot Chat contracts and safe bindings`

## Files changed

- `server/engines/contracts.ts`
  - Added the internal Hermes capability, profile, canonical-chat, discovery,
    binding, and typed failure contracts.
  - Capability keys are explicit; unsupported message-agent, group,
    cross-machine, queueing, steer, attachment, and routine capabilities stay
    false unless a later transport explicitly proves support.
- `server/engines/discovery.ts`
  - Added bounded, deterministic profile normalization with the default
    `hermes` handle, case-insensitive named slugs, duplicate/invalid handle
    fail-closed behavior, and safe omission of path/raw metadata.
  - Added exact Bot Chat canonical lookup normalization, hidden-row inclusion,
    denied `kanban`/`tool` sources, compression root/tip retention in the
    internal result, and present/absent/unknown discrimination.
  - Added capability projection that enables only transport-proven Wave 1
    operations.
- `server/engines/bindings.ts`
  - Added strict version-1 sidecar decoding and small load/set/remove methods.
  - Missing storage is an available empty set; malformed or unreadable
    existing storage is unavailable and is never replaced with `{}`.
  - Parent directories are verified/repaired to `0700`; replacements use the
    existing atomic writer with `0600` files and preserve the prior file on
    validation or replacement failure.
- `server/engines/contracts.test.ts`
- `server/engines/discovery.test.ts`
- `server/engines/bindings.test.ts`
  - Added red/green coverage for contracts, normalization, title/source rules,
    bounded safe projections, strict sidecar validation, private modes, and
    fail-closed mutation behavior.

## TDD evidence

Red first (before production modules existed):

```text
./node_modules/.bin/vitest run server/engines/contracts.test.ts \
  server/engines/discovery.test.ts server/engines/bindings.test.ts
```

Failed at collection with the expected missing-module errors for
`./contracts.ts`, `./discovery.ts`, and `./bindings.ts`.

The prescribed `pnpm vitest run ...` command was also attempted, but this
desktop runtime invokes an automatic dependency install first and stopped on
its existing ignored-build policy for `core-js`/`workerd`; no source files were
changed by that failed setup step.

Focused green:

```text
./node_modules/.bin/vitest run server/engines/contracts.test.ts \
  server/engines/discovery.test.ts server/engines/bindings.test.ts
```

13 tests passed, 0 failures.

TypeScript and whitespace checks:

```text
./node_modules/.bin/tsc -p tsconfig.server.json --noEmit
git diff --check
```

Both passed. The direct TypeScript invocation is equivalent to the server
portion of the requested `pnpm typecheck` gate; the same automatic pnpm setup
failure above prevented the wrapper command from reaching `tsc`.

## Security self-review

- Public `server/contracts.ts` and iOS wire contracts were untouched.
- Profile/path-like and Hermes metadata fields are never copied into roster
  rows or binding records. Binding profiles accept only bounded slugs and
  reject path forms, session-id-shaped values, alternate titles, and schema
  drift.
- Error instances expose only a stable typed code and sanitized human message;
  path, argv, stderr, provider, token, prompt, query, and state-store details
  are not retained in messages.
- Sidecar reads reject symlinks, non-files, unreadable files, malformed JSON,
  schema/version drift, unsafe binding keys, and invalid bindings. Failed
  writes use the existing atomic sibling replacement and leave prior bytes
  intact when replacement cannot complete.
- Serialized sidecars contain only V Bot id -> adapter/profile/title/version;
  no Hermes path, environment, token, prompt, durable session id, or raw
  provider payload is persisted.

## Concerns / root verification

- The `pnpm` wrapper's preflight currently fails on its unrelated ignored
  `core-js`/`workerd` build policy. Root should rerun the prescribed commands
  if that workspace setup is repaired.
- No transport, HTTP, SQLite, Hermes import, provider registry, public
  contract, deployment, or live runtime behavior was changed in this task.
- Root should independently inspect the branch diff and rerun the focused
  tests/typecheck before integrating Task 2.

## Review-fix implementation

- Profile slugs and durable canonical session ids are now validated from their
  original values before any display bounding. Leading/trailing/internal
  whitespace, controls, and overlength values fail closed; eligible ids are
  retained byte-for-byte and profile/sidecar ordering uses deterministic
  Unicode code-point comparison.
- `HermesEngineError` now selects its message exclusively from the stable
  failure-code table. Any caller-supplied diagnostic argument is ignored, so
  paths (including relative paths), argv, stderr, provider payloads, and query
  text cannot reach public error strings.
- Binding mutations now hold a process-safe directory lock and perform an
  inode/mode/byte snapshot check before publication. Atomic publication is
  verified at mode `0600`, failed/post-publication mutations restore the exact
  prior bytes, and lock identity is checked before release. Concurrent
  read-modify-write operations retain every update.
- Canonical source/type validation is strict, malformed profile booleans and
  field types remain unavailable, and roster normalization exposes a typed
  `normalizeProfileRowsResult` plus a non-enumerable state marker/safe
  unavailable row so malformed payloads cannot look like a valid empty roster.
  Missing binding storage remains an available empty set.

## Review-fix TDD evidence

Red assertions were added for raw validation, fixed diagnostics, malformed
roster state, source/type denial, publication rollback, and a two-process
lost-update race. Focused verification is green:

```text
./node_modules/.bin/vitest run server/engines/contracts.test.ts \
  server/engines/discovery.test.ts server/engines/bindings.test.ts
```

22 tests passed, 0 failures.

```text
./node_modules/.bin/tsc -p tsconfig.server.json --noEmit
git diff --check
```

Both passed. No transport, HTTP, iOS, public contract, or deployment files
  were changed.

## Final review fixes

- `normalizeProfileRowsResult` now returns a typed `state_unavailable` result
  for explicit roster failure markers (`error`, `ok: false`, `success: false`,
  failure/status/state markers), including responses that also contain
  `profiles: []`; an unmarked `{profiles: []}` remains an available empty
  roster.
- Profile sorting now compares every projected roster field, including
  `canonicalChat` and `availability`, without using input position as a
  tiebreaker. Permutation regression coverage guards deterministic output.

Focused final verification:

```text
./node_modules/.bin/vitest run server/engines/contracts.test.ts \
  server/engines/discovery.test.ts server/engines/bindings.test.ts
```

29 tests passed, 0 failures.

```text
./node_modules/.bin/tsc -p tsconfig.server.json --noEmit
git diff --check
```

Both passed.

## Envelope marker validation fix

- `normalizeProfileRowsResult` now validates every recognized roster envelope
  marker (`ok`, `success`, `failed`, `available`, `error`, `failure`, `status`,
  and `state`) before projecting rows. Wrong-type, contradictory, and unknown
  non-success domains return typed `state_unavailable` rather than an available
  empty roster. Only explicit recognized success markers are accepted.
- Added table coverage for malformed/unknown markers and recognized success
  markers with valid profiles.

Focused verification:

```text
./node_modules/.bin/vitest run server/engines/contracts.test.ts \
  server/engines/discovery.test.ts server/engines/bindings.test.ts
```

53 tests passed, 0 failures. Server `tsc --noEmit` and `git diff --check`
also passed.
