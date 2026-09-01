# Task 2 implementation report

Commit: `33ff1ea` (`feat(ios): add premium home activity pill`)

## Files changed

- `ios/Sources/CompanionCore/HomeActivityPresentation.swift`
  - Added provider-neutral `quiet`, `active`, and `needsAttention` projection.
  - Added ordered `Needs you`, `Active`, `Queued`, and `Recently finished` sections.
  - Approval precedence suppresses duplicate active/queued rows for the same thread; unread idle threads remain reviewable.
  - Queue rows accept only explicit phone-observed `HomeActivityQueueReceipt` values. Unknown/stale/hidden threads are omitted; no global queue truth is inferred.
  - Added calm collapsed copy, activity counts, and VoiceOver copy.
- `ios/Tests/CompanionCoreTests/HomeActivityPresentationTests.swift`
  - Added reducer, precedence/order, queue-boundary, and provider-neutral copy tests.
- `ios/App/HomeActivityPill.swift`
  - Added bottom-safe-area inset pill with in-place upward expansion, existing chat navigation, ordered sections, 44pt targets, Dynamic Type-friendly system fonts, Reduce Motion opacity-only transition, and VoiceOver state/count labels.
- `ios/App/Updates.swift`
  - Added the app-layer adapter from the core projection to existing `ChatUpdate` and documented the queue trust boundary.
- `ios/App/UpdatesSheet.swift`
  - Reused the core projection and rendered all four ordered groups while retaining the existing updates sheet route.
- `ios/App/ChatListView.swift`
  - Installed the pill as a `.safeAreaInset(edge: .bottom)` so roster rows are reserved rather than covered.

## TDD evidence

Red first (before production implementation):

```text
swift test --package-path ios --filter HomeActivityPresentationTests
```

Failed at compile time as expected because `HomeActivityPresentation` and `HomeActivityQueueReceipt` did not yet exist.

Focused green:

```text
swift test --package-path ios --filter HomeActivityPresentationTests
```

3 tests passed, 0 failures.

## Full verification

```text
swift test --package-path ios
```

683 tests passed, 0 failures.

Unsigned simulator build (after `xcodegen generate` to include the new app source):

```text
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`** BUILD SUCCEEDED **` (iOS simulator SDK 26.5, iOS deployment target 17.0).

## Accessibility / motion self-review

- Collapsed and expanded controls use minimum 44pt frames; item rows reserve at least 44pt.
- System `subheadline`/`caption` fonts and multiline limits preserve Dynamic Type growth without fixed-height clipping.
- Reduce Motion selects opacity-only insertion/removal and disables the spring transaction.
- VoiceOver reads the provider-neutral state/count on the collapsed control and the chat/group/subtitle on each item.
- The pill is a bottom safe-area inset, so expanding it shifts scrollable roster content instead of obscuring rows. The existing top needs-you island remains unchanged; the pill has no separate approval action button.

## Concerns and root verification

- Queue receipts remain a caller-provided, in-memory boundary because the paired hub does not expose a global queue snapshot and the existing receipt state is chat-scoped. The pill therefore shows no queued rows until a real observed receipt is supplied; it never fabricates queue state.
- No physical-device VoiceOver/Reduce Motion pass or screenshot review was performed. Root should inspect the home on a simulator/device at normal and large Dynamic Type, especially the expanded panel's visual balance with the top needs-you island.
- No backend, dependency, bundle identity, build number, signing, deployment, or TestFlight state changed.

## Review-fix implementation

- Added `HomeActivityQueueReceiptStore` in `CompanionCore` as the app-owned,
  in-memory receipt lifecycle. It records only successful queued acknowledgements,
  uses the request thread as a safe fallback when an older hub omits `threadId`,
  and retires receipts when their server queue id lands in the transcript or a
  full hydrate no longer represents them.
- `Session` now publishes the locally observed receipts to both the home pill
  and updates sheet, reconciles them from stream/transcript/hydrate changes,
  and clears them when the active pairing changes. `ChatView` no longer owns a
  private queue dictionary.
- `HomeActivityQueueReceipt.init(receipt:)` now rejects failed acknowledgements
  (`ok == false`) before considering queue metadata. No Hub-global queue state
  is inferred or persisted.

## Review-fix TDD evidence

Red before implementation:

```text
swift test --package-path ios --filter 'HomeActivityPresentationTests|HomeActivityQueueReceiptStoreTests'
```

Failed to compile because `HomeActivityQueueReceiptStore` did not yet exist.

Focused green:

```text
swift test --package-path ios --filter HomeActivityPresentationTests
```

4 tests passed, 0 failures.

```text
swift test --package-path ios --filter HomeActivityQueueReceiptStoreTests
```

3 tests passed, 0 failures.

Full Swift package gate:

```text
swift test --package-path ios
```

686 tests passed, 0 failures.

Unsigned simulator build:

```text
xcodegen generate
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`** BUILD SUCCEEDED **` (iOS simulator SDK 26.5, iOS deployment target 17.0).
