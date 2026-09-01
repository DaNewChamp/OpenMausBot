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
