# Task 1 implementation report

Commit: `a0ed9ba` (`fix(ios): refine home chrome and connection feedback`)

## Files changed

- `ios/Sources/CompanionCore/HomeRosterLayoutPolicy.swift`
  - Profile avatar 36pt; 44pt profile target.
  - Chrome circles 44pt, 17pt symbols, 8pt gap.
  - Central single-pin hero fraction set to 20%.
- `ios/Sources/CompanionCore/CalmSurfacePolicy.swift`
  - `PinnedChatShelfLayout` now consumes the home policy's 20% hero fraction (required because this is where the shelf metrics live).
- `ios/Sources/CompanionCore/ConnectionResiliencePolicy.swift`
  - Added `Banner.showsConnectingHalo` and `Banner.showsRosterText` projections.
  - Initial connecting state is not a roster text banner; reconnecting/offline/unauthorized remain roster-visible.
  - Offline VoiceOver label is generic (`Offline`) so route/advice text is not exposed.
- `ios/Tests/CompanionCoreTests/HomeRosterLayoutPolicyTests.swift`
  - Added/updated metric and clipping/reservation assertions for the new scale.
- `ios/Tests/CompanionCoreTests/ConnectionResiliencePolicyTests.swift`
  - Added projection/accessibility tests for initial connecting, reconnecting, offline, and unauthorized states.
- `ios/App/ChatListView.swift`
  - Added a subtle rotating profile halo for initial connecting; Reduce Motion renders a static ring.
  - Initial connecting text is omitted; actionable banners still render.
  - Profile VoiceOver value reports connection state without route details.
  - Header controls use policy dimensions and 17pt symbols.
- `ios/App/PinnedChatShelf.swift`
  - Documented the 20% single-hero metric and guaranteed caption breathing-room minimum height.

## TDD evidence

Red first (before production changes):

```text
swift test --package-path ios --filter 'HomeRosterLayoutPolicyTests|ConnectionResiliencePolicyTests'
```

Failed at compile time as expected because the new policy metrics/projections (`chromeButtonSymbolSize`, `showsConnectingHalo`, `showsRosterText`, `offlineAccessibility`) did not yet exist.

Green focused run:

```text
swift test --package-path ios --filter 'HomeRosterLayoutPolicyTests|ConnectionResiliencePolicyTests'
```

23 tests passed, 0 failures.

## Full verification

```text
swift test --package-path ios
```

683 tests passed, 0 failures.

Generated the ignored Xcode project with `xcodegen generate`, then ran an unsigned simulator build:

```text
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`** BUILD SUCCEEDED **` (iOS simulator SDK 26.5, iOS deployment target 17.0).

## Accessibility / motion self-review

- Profile, search, and add controls retain at least 44pt hit targets.
- Halo is marked accessibility-hidden; the profile control reports `Connecting to your computer`, `Reconnecting to your computer`, or generic offline/unauthorized state through its value.
- Reduce Motion disables TimelineView rotation and uses a static stroked ring. Existing shelf/list animations also retain their Reduce Motion branches.
- Reconnecting, offline, and unauthorized banners remain visible and actionable; only initial connecting text is replaced.

## Concerns and root verification

- The brief's file list omitted `CalmSurfacePolicy.swift`, but `PinnedChatShelfLayout.heroAvatarWidthFraction` is defined there; it was updated to consume the new `HomeRosterLayoutPolicy` fraction so runtime metrics actually reach the shelf.
- No physical-device VoiceOver/Reduce Motion pass or visual screenshot review was performed in this bounded implementation. Root should inspect the home on a simulator/device at normal and large Dynamic Type, especially the halo against the 44pt glass profile control and the 20% hero caption clearance.
- No backend, dependency, bundle identity, build number, signing, deployment, or TestFlight state was changed.
