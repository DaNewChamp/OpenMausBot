# Task 3 implementation report

## Status

Implemented provider-agnostic work and PR cards. The prescribed commit is
created after the verification gates below.

## Files changed

- `ios/Sources/CompanionCore/Models.swift`
  - Added optional `WorkCard` metadata for title, status, branch, PR number,
    file/change counts, PR URL, and Cursor deep link.
  - Message decoding keeps malformed or unknown work extensions from dropping
    ordinary transcript messages; compatibility aliases accept `workCard` and
    `workMetadata` envelopes without changing the canonical `work` encoding.
- `ios/Sources/CompanionCore/WorkCardPresentation.swift`
  - Added provider-neutral projection and strict HTTPS/Cursor URL validation.
  - PR actions require a validated HTTPS URL; Cursor actions additionally
    require the caller's runtime `canOpenURL` result.
- `ios/Tests/CompanionCoreTests/WorkCardPresentationTests.swift`
  - Added decoding, malformed/ordinary degradation, HTTPS validation, Cursor
    action gating, and empty-metadata tests.
- `ios/App/Cards/GitPRDiffCardView.swift`
  - Added optional work metadata summary and gated `View PR` / `Open in Cursor`
    actions. All card controls have explicit accessibility labels and at least
    44-point targets; copy is omitted when a work-only card has no diff.
- `ios/App/ChatView.swift`
  - Projects bot work metadata into the existing diff-card surface while
    preserving ordinary prose and existing diff/table parsing. Cursor
    availability is checked with `UIApplication.shared.canOpenURL` only after
    deep-link validation.

## TDD evidence

Red first (before production implementation):

```text
swift test --package-path ios --filter WorkCardPresentationTests
```

Failed to compile because `Message.work`, `WorkCard`, and
`WorkCardPresentation` did not yet exist.

Focused green:

```text
swift test --package-path ios --filter WorkCardPresentationTests
```

5 tests passed, 0 failures.

## Full verification

```text
swift test --package-path ios
```

691 tests passed, 0 failures.

Unsigned simulator build (isolated derived-data path to avoid another Xcode
process's build database lock):

```text
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /tmp/vbot-task3-derived-0831 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`** BUILD SUCCEEDED **` (iOS simulator SDK 26.5, iOS deployment target 17.0).

## Self-review / concerns

- No provider, repository, PR URL, Cursor installation, backend route,
  dependency, bundle identity, build number, signing, deployment, or TestFlight
  state was changed.
- `UIApplication.canOpenURL` remains the runtime authority for Cursor; if the
  app is not installed or iOS does not permit the scheme query, the button is
  absent. No Cursor availability is inferred from model/provider names.
- No physical-device VoiceOver/Dynamic Type/screenshot pass was performed;
  root should inspect the card at large text sizes and with a valid Cursor
  installation.

## Review fixes (2026-09-01)

### Changes

- A single available Hermes profile now uses the one-tap `Connect Hermes`
  action; the profile list is rendered only when two or more available
  profiles exist.
- Connected profile rows use their existing bot id to open the chat directly.
  They never call the setup/connect route again, and stale imported bots fail
  with a plain refresh message.
- Successful setup now hands the hydrated chat directly to the roster root.
  The root closes the Account/Settings sheet and pushes the chat in one
  handoff; no Session-level pending Hermes navigation state remains.
- Setup requests retain their task handle and cancel on view disappearance or
  replacement. Session checks cancellation after the fleet refresh before
  publishing success, so backing out cannot open a later chat. The unused
  reduce-motion environment value was removed from the setup screen.

### TDD evidence

Red first:

```text
swift test --package-path ios --filter HermesSetupTests
```

Failed to compile because the new profile-list and connected-profile action
policy members were not yet present.

Focused green:

```text
swift test --package-path ios --filter HermesSetupTests
```

6 tests passed, 0 failures.

Full package verification:

```text
swift test --package-path ios
```

753 tests passed, 0 failures.

Unsigned simulator builds:

```text
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /tmp/vbot-task3-fix-debug3 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`** BUILD SUCCEEDED **`

```text
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -derivedDataPath /tmp/vbot-task3-fix-release \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`** BUILD SUCCEEDED **`

```text
git diff --check
```

Passed with no whitespace errors.

## Review fixes (2026-08-31)

### Important finding: Cursor query permission

`ios/project.yml` now declares only `LSApplicationQueriesSchemes: [cursor]`.
The existing `CFBundleURLTypes` handler remains pairing-only (`openmausbot`);
no `cursor` URL handler was added. There is no tracked config-test seam for
the XcodeGen spec, so the generated source plist was validated directly after
`xcodegen generate`:

```text
plutil -p ios/App/Info.plist
  "CFBundleURLTypes" => ... "openmausbot"
  "LSApplicationQueriesSchemes" => [ "cursor" ]
```

The unsigned simulator product also carries the generated query scheme:

```text
/usr/libexec/PlistBuddy -c 'Print :LSApplicationQueriesSchemes' ios/App/Info.plist
Array {
    cursor
}
```

### Important finding: Cursor-only blank card

TDD red first (before the production change):

```text
swift test --package-path ios --filter WorkCardPresentationTests
testCursorOnlyMetadataDoesNotCreateAWorkCardWhenCursorCannotOpen: XCTAssertFalse failed
```

`WorkCardPresentation.isRenderable` now treats a Cursor deep link as
renderable only when `showsOpenInCursor` is actionable; visible metadata and a
validated PR URL remain renderable as before. The new test confirms Cursor-only
metadata is hidden when `canOpenCursor == false` and remains renderable when
the action is available. Focused green:

```text
swift test --package-path ios --filter WorkCardPresentationTests
Executed 6 tests, with 0 failures
```

Full package verification:

```text
swift test --package-path ios
Executed 692 tests, with 0 failures
```

Project generation and unsigned simulator build:

```text
xcodegen generate
Created project at .../ios/OpenMausCompanion.xcodeproj
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /tmp/vbot-task3-fixes-derived-0831-final \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
** BUILD SUCCEEDED **
```

No backend, dependency, bundle, build-number, signing, or TestFlight files
were changed.

## Wave 1 Task 3 — Native iOS Hermes connect (2026-09-01)

### Status

Implemented and committed on `feat/vbot-hermes-adapter-0901`.

### Commits

- `4af16e6` — `feat(ios): add Hermes setup client contract`
- `8bfedb9` — `feat(ios): add first-party Hermes connect screen`

### Implemented

- Added safe Codable Hermes setup state, profile, capability, and connection
  response models with unknown-value tolerance and no secret-bearing fields.
- Added authenticated `GET /api/hermes/setup/status` and
  `POST /api/hermes/setup` client routes. Default connect sends `{}`; an
  explicit profile sends only the validated profile slug.
- Added plain-language presentation policy for checking, ready, connected,
  needs-install/login, and unavailable states. Profile selection is rendered
  only when more than one available profile exists.
- Added a first-party Hermes row under a separate Settings Integrations group,
  outside the reconstructed Desktop engine picker. The flow explains same-
  computer and paired-other-machine placement, refreshes the fleet after a
  successful connect, and queues the imported bot for smooth roster
  navigation.
- Preserved existing pairing, stream, engine-picker, and model-list behavior.

### TDD evidence

Red first (before production implementation):

```text
cd ios && swift test --filter HermesSetupTests
```

Failed to compile because `HermesSetupStatus`, `HermesSetupProfile`,
`CompanionClient.hermesSetupStatus`, `CompanionClient.connectHermes`, and
`HermesSetupPresentationPolicy` did not yet exist.

Focused green:

```text
cd ios && swift test --filter HermesSetupTests
```

5 tests passed, 0 failures.

### Verification

```text
cd ios && swift test
```

752 tests passed, 0 failures.

```text
cd ios && xcodegen generate
cd ios && xcodebuild -project OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  CODE_SIGNING_ALLOWED=NO build
```

Debug simulator build: `** BUILD SUCCEEDED **`.

```text
cd ios && xcodebuild -project OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  CODE_SIGNING_ALLOWED=NO -configuration Release build
```

Release simulator build: `** BUILD SUCCEEDED **`.

```text
git diff --check HEAD~2..HEAD
```

Passed with no whitespace errors.

### Security and compatibility review

- iOS decodes only the server's safe Hermes projection; no credentials, local
  paths, runtime/session ids, stderr, or provider payloads are accepted or
  displayed.
- Profile choice is sourced from the server roster and the phone sends only an
  optional profile slug; no free-form command/config input exists.
- Existing device pairing identity and Keychain token handling are untouched.
- Existing iOS contracts and the reconstructed engine picker remain unchanged;
  Hermes is a separate first-party integration row.
- No dependencies, deployment, signing, TestFlight upload, production
  resources, or remote Hermes bridge were changed.

### Remaining Wave 2 dependencies / residuals

- No remote Hermes-over-bridge transport is implemented; Task 4 documents this
  boundary and the next transport work.
- A physical-device UX pass and authenticated Hermes end-to-end run remain
  release validation steps; this task only verified client contracts, policy,
  and unsigned simulator builds.
