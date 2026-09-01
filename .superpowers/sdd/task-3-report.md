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
