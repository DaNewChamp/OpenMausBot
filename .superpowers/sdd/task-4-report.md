# Task 4 integrated visual and release gate

Date: 2026-08-31 (America/Chicago)
Branch: `feat/vbot-ios-home-activity-0831`
Starting commit: `5f05fed fix(ios): gate cursor-only work cards`

## Status

The initial simulator and core release gates passed. Home activity states that
the existing StorePreview fixture can represent were captured and inspected;
the preview expansion race and accessibility layout were corrected in the
final section below. TestFlight upload, signed export, and physical-device
verification remain intentionally out of scope here.

## Commands and results

All commands were run from `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831`.

```sh
swift test --package-path ios 2>&1 | tee /tmp/vbot-task4-swift-test-0831.log
```

Passed: 692 XCTest cases with zero failures; the trailing Swift Testing run
reported 17 tests in four suites passed.

```sh
cd ios && xcodegen generate 2>&1 | tee /tmp/vbot-task4-xcodegen-0831.log
```

Passed: generated
`ios/OpenMausCompanion.xcodeproj` from `ios/project.yml`.

Unsigned simulator Debug build:

```sh
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-task4-debug-derived-0831 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build \
  2>&1 | tee /tmp/vbot-task4-debug-build-0831.log
```

Passed: `** BUILD SUCCEEDED **` (iOS Simulator SDK 26.5).

Unsigned simulator Release build:

```sh
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-task4-release-derived-0831 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build \
  2>&1 | tee /tmp/vbot-task4-release-build-0831.log
```

Passed: `** BUILD SUCCEEDED **` (iOS Simulator SDK 26.5).

## Simulator evidence

Device: iPhone 17 Pro, iOS 26.5, UDID
`334FC58E-19DA-460C-AC2A-1D34D7CAA916`, dark appearance. The normal text-size
pass used `large`; the accessibility pass used
`accessibility-extra-extra-extra-large`. Reduce Motion was set explicitly for
each pass. Screenshots are 1206 x 2622 PNGs.

| State | Launch/interaction | Setting | Capture |
| --- | --- | --- | --- |
| Needs approval | `-store-preview`; top needs-you Island shown | `large`, Reduce Motion off | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/02-home-needs-approval-normal.png` |
| Expanded pill | `-store-preview`; tap the activity surface after launch | `large`, Reduce Motion off | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/03-home-needs-approval-expanded-pill.png` |
| Active pill | `-store-preview -preview-single-pin -preview-bot=preview-parity` | `large`, Reduce Motion off | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/04-home-active-normal-reduced-motion-off.png` |
| Quiet home | `-store-preview -preview-single-pin -preview-bot=preview-forge -preview-computer=cloud-viewer`; open unread Scout, then return to home | `large`, Reduce Motion off | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/06-home-quiet-normal-reduced-motion-off.png` |
| Needs approval | `-store-preview` | accessibility XXXL, Reduce Motion on | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/07-home-needs-approval-accessibility-xxxl-reduce-motion-on.png` |
| Expanded pill | `-store-preview`; tap the activity surface after launch | accessibility XXXL, Reduce Motion on | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/08-home-expanded-pill-accessibility-xxxl-reduce-motion-on.png` |
| Expanded pill after scroll | Same as above; swipe the activity panel upward | accessibility XXXL, Reduce Motion on | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/10-home-expanded-pill-accessibility-xxxl-scrolled.png` |
| Needs approval | `-store-preview` | `large`, Reduce Motion on | `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831/.superpowers/sdd/task-4-screenshots/09-home-needs-approval-normal-reduce-motion-on.png` |

The normal captures had no Critical or Important spacing, overlap, or clipping
findings. At accessibility XXXL, the expanded panel remains a scroll view; the
first frame shows the second row below the viewport and the scrolled capture
shows it fully, so no content is inaccessible. Text intentionally ellipsizes
within the existing one- or two-line limits. The Reduce Motion captures show a
static transition rather than the spring/rotation path.

## States not produced in the initial pass

The following states were not produced by the initial pre-remediation capture
pass. The post-`f891526` closure below supplies the missing portable evidence.

- **Initial connecting halo:** the StorePreview initializer hydrates its
  fixture and sets `Session.status = .live`; no existing launch argument keeps
  that preview connection in `.connecting`. Producing this state would require
  inventing a debug-only fixture behavior, so no unsupported behavior was
  added.
- **Work card with optional actions / work card without actions:**
  `ios/App/StorePreview.json` contains no `Message.work`, `workCard`, or
  `workMetadata` payload. The work-card projection and its unit tests are
  covered by Task 3, but the existing store-preview launch path cannot render
  either card state. No synthetic message was injected for this release gate.

## Remaining release gates

- Pair and exercise the roster, approval, reconnect, dictation, and revoke
  flows on a physical iPhone with Local Network, notifications, microphone,
  speech, VoiceOver, Dynamic Type, and Reduce Motion settings.
- Run the signed device archive/export and confirm the next build number and
  provisioning in the GUI-context MacBook lane.
- Upload to TestFlight only after separately confirmed release authorization;
  no upload was attempted here.

## Root verification

Before merging or releasing, root should review the branch diff, confirm the
generated project is ignored, rerun `git diff --check`, verify the exact
screenshots above, and independently rerun the Swift and unsigned Debug/Release
simulator gates. The required documentation commit is
`docs(ios): record home parity release evidence`.

## Task 4 remediation and visual gate rerun

Date: 2026-08-31 (America/Chicago)
Starting commit: `25ae27b docs(ios): record home parity release evidence`

The omitted visual states and review findings are now covered without changing
normal production contracts:

- `Session` keeps StorePreview's requested `.connecting` status, does not start
  the fake stream while `-store-preview` is active, and applies all other
  fixture mutations before the view appears.
- The DEBUG-only `StorePreviewHarness` supports `-preview-connecting`,
  `-preview-quiet`, `-preview-active`, and
  `-preview-work-card=actions|plain` (with the explicit
  `-preview-cursor-available` capture override). The work-card fixture is
  provider-neutral and includes a diff plus optional PR/Cursor actions only in
  the actions variant. No release build or production state path consumes
  these arguments.
- The activity rail is a sibling below the roster scroll view instead of a
  safe-area overlay. At accessibility XXXL, its expanded panel reserves its
  full height and remains a vertical ScrollView; enlarged roster rows stay
  outside the panel and remain reachable.
- `ios/TESTING.md` now uses `(cd ios && xcodegen generate)` so the documented
  command is safe to paste from the repository root, and documents the fixture
  controls, matrix, and portable evidence directory.
- Release notes and every generated target now use build 72. `ios/project.yml`
  is the build-number source of truth (`CURRENT_PROJECT_VERSION: "72"` for the
  app, widget, and share targets).
- Portable simulator evidence is tracked at
  `ios/AppStore/screenshots/task-4-home-activity-2026-08-31/` (22 PNGs,
  1206 x 2622): needs-approval, connecting halo, quiet/active `large` and
  accessibility XXXL with Reduce Motion on/off, expanded active XXXL, and
  work-card actions/no-actions captures. Connecting captures `20` and `21`
  retain their `post-f891526` suffix; expanded activity captures were
  recaptured after the preview-expansion fix to close the accessibility matrix.

### Rerun commands

All commands ran from `/Users/Vincent/Github/.worktrees/vbot-ios-home-activity-0831`.

Focused Swift tests:

```sh
swift test --package-path ios --filter 'HomeActivityPresentationTests|WorkCardPresentationTests'
```

Passed: 10 focused tests (four HomeActivity Swift Testing cases and six
WorkCard XCTest cases).

Full Swift tests:

```sh
swift test --package-path ios 2>&1 | tee /tmp/vbot-task4-swift-test-final.log
```

Passed: 692 XCTest cases with zero failures; the trailing Swift Testing run
reported 17 tests in four suites passed.

Project generation (copy/paste-safe from repository root):

```sh
(cd ios && xcodegen generate)
```

Passed: generated `ios/OpenMausCompanion.xcodeproj` from `ios/project.yml`.

Unsigned simulator Debug build:

```sh
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-task4-debug-derived-final2 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Passed: `** BUILD SUCCEEDED **` (iOS Simulator SDK 26.5).

Unsigned simulator Release build:

```sh
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-task4-release-derived-final2 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Passed: `** BUILD SUCCEEDED **` (iOS Simulator SDK 26.5).

### Evidence inspection

The connecting captures show the profile halo while the roster remains stable;
Reduce Motion on/off produces the same static frame. Quiet captures show
`All quiet` / `Nothing needs you`; active captures show `1 active` / `Working
now` and the working indicator. The XXXL expanded captures show the activity
panel below the enlarged roster content, with the panel's internal ScrollView
holding the remaining active or needs-you rows. Work-card captures show the complete diff,
copy action, and (actions variant only) `View PR` and `Open in Cursor` buttons.
No Critical or Important clipping/overlap finding remains in the inspected
captures.

No signing, device archive, TestFlight upload, deploy, merge, or production
resource change was attempted.

## Post-f891526 portable evidence closure

Date: 2026-08-31 (America/Chicago)
Starting commit: `f891526 fix(ios): close home activity visual gate`

The post-remediation Debug simulator build was installed on the same iPhone 17
Pro simulator (iOS 26.5, UDID
`334FC58E-19DA-460C-AC2A-1D34D7CAA916`) and recaptured at
`accessibility-extra-extra-extra-large`. Reduce Motion was set explicitly for
each launch. This build-only step was needed to exercise the current layout;
no full test suite or signed build was rerun.

| State | Fixture and setting | Portable capture |
| --- | --- | --- |
| Needs-attention expanded activity | `-store-preview -preview-expand-activity`; accessibility XXXL, Reduce Motion on | `ios/AppStore/screenshots/task-4-home-activity-2026-08-31/18-expanded-needs-xxxl-reduce-motion-on-post-preview-expansion-fix.png` |
| Needs-attention expanded activity | `-store-preview -preview-expand-activity`; accessibility XXXL, Reduce Motion off | `ios/AppStore/screenshots/task-4-home-activity-2026-08-31/19-expanded-needs-xxxl-reduce-motion-off-post-preview-expansion-fix.png` |
| Initial connecting | `-store-preview -preview-connecting`; accessibility XXXL, Reduce Motion on | `ios/AppStore/screenshots/task-4-home-activity-2026-08-31/20-connecting-xxxl-reduce-motion-on-post-f891526.png` |
| Initial connecting | `-store-preview -preview-connecting`; accessibility XXXL, Reduce Motion off | `ios/AppStore/screenshots/task-4-home-activity-2026-08-31/21-connecting-xxxl-reduce-motion-off-post-f891526.png` |

The connecting captures show the halo around the profile while the enlarged
roster remains stable. The original expanded needs-attention captures from
this pass were later found to be collapsed when the first frame raced fixture
hydration; they are superseded by the preview-expansion-fix recaptures below.

The connecting PNGs are 1206 x 2622 and remain part of the portable evidence
set; the needs-attention files above were superseded by the preview-expansion
fix capture below.

## Preview expansion race and accessibility evidence repair

Date: 2026-08-31 (America/Chicago)

The DEBUG-only activity expansion now observes `presentation.items` and retries
after StorePreview hydration, so `-preview-expand-activity` no longer races an
empty first projection. Normal production launches do not auto-expand. At
accessibility XXXL the expanded panel reserves 400 points, renders the complete
needs-you detail, and shows a vertical scroll indicator; the panel remains a
sibling below the roster scroll view.

Focused verification:

```sh
swift test --package-path ios --filter HomeActivityPreviewExpansionPolicyTests
```

Passed: three focused Swift Testing cases. Unsigned Debug simulator build
passed with `** BUILD SUCCEEDED **` using iOS Simulator SDK 26.5 (derived data
`/tmp/vbot-task4-debug-derived-final400fixed0831`). No full suite, signing,
archive, upload, or device release gate was run for this correction.

Portable recaptures (iPhone 17 Pro, iOS 26.5, 1206 x 2622, dark appearance):

| State | Fixture and setting | Capture |
| --- | --- | --- |
| Needs-attention expanded activity | `-store-preview -preview-expand-activity`; XXXL, Reduce Motion on | `18-expanded-needs-xxxl-reduce-motion-on-post-preview-expansion-fix.png` |
| Needs-attention expanded activity | `-store-preview -preview-expand-activity`; XXXL, Reduce Motion off | `19-expanded-needs-xxxl-reduce-motion-off-post-preview-expansion-fix.png` |
| Active expanded activity | `-store-preview -preview-active -preview-bot=preview-forge -preview-expand-activity`; XXXL, Reduce Motion on | `13-expanded-active-xxxl-reduce-motion-on.png` |
| Active expanded activity | `-store-preview -preview-active -preview-bot=preview-forge -preview-expand-activity`; XXXL, Reduce Motion off | `24-expanded-active-xxxl-reduce-motion-off-post-preview-expansion-fix.png` |

The needs-attention captures visibly include the `NEEDS YOU` section, Scout,
and the complete “Upload build 1 to TestFlight for internal testing?” detail.
The active captures visibly include `ACTIVE`, Forge, and `Working now`. The
expanded rail is laid out as a sibling below the roster, with no panel-over-row
overlay in either Reduce Motion setting.

## Final review fixes

Date: 2026-08-31 (America/Chicago)
Starting commit: `5832545 chore(ios): prepare TestFlight build 72`

The final review findings are closed on this branch:

- Queue receipts are retired as absent only when a hydrate has both a transcript
  and explicit `hasMore: false`. Paged (`hasMore: true`) and unknown/partial
  transcripts retain local receipts; matching queue IDs still retire normally
  as messages arrive.
- `ConnectionResiliencePolicy.Banner.isVisible` again follows its legacy
  contract (`kind != .hidden`). The new roster layout continues to use
  `showsRosterText` so the connecting halo does not reserve banner text space.
- `UpdatesSheet` activity and permission detail use Dynamic Type text styles,
  multiline sizing, and uncapped lines at accessibility sizes. No projection
  logic changed, so the existing core presentation tests remain the focused
  coverage; source inspection confirmed there are no fixed-size or one-line
  activity labels in the row.
- `ios/project.yml` is the build-number source of truth and sets
  `CURRENT_PROJECT_VERSION: "72"` for the app, widget, and share targets.

Focused verification:

```sh
swift test --package-path ios --filter 'HomeActivityQueueReceiptStoreTests|ConnectionResiliencePolicyTests'
```

Passed: 10 focused XCTest cases with zero failures.

Full Swift verification:

```sh
swift test --package-path ios
```

Passed: 697 XCTest cases with zero failures; the trailing Swift Testing run
reported 20 tests in five suites passed.

Project generation and unsigned simulator release gates also passed:

```sh
(cd ios && xcodegen generate)
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-final-review-debug-0831 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-final-review-release-0831 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
git diff --check
```

All commands passed; both simulator builds ended with `** BUILD SUCCEEDED **`
using iOS Simulator SDK 26.5. No signing, device archive, TestFlight upload,
deploy, merge, or backend contract change was attempted.

## Final accessibility pill containment fix

Date: 2026-09-01 (America/Chicago)
Starting commit: `f348faa fix(ios): close final review gaps`

The final Important finding is closed. `HomeActivityPill` now keeps its normal
44-point premium rail at regular Dynamic Type sizes. At accessibility sizes it
uses compact single-line visual copy and a 112-point minimum rail height with
vertical padding, so XXXL text stays inside the capsule and below the roster or
expanded panel. The full presentation label/value and hint remain on the one
tappable button for VoiceOver; the rail remains a sibling of the roster.

The sizing contract is isolated in
`ios/Sources/CompanionCore/HomeActivityRailLayoutPolicy.swift` and covered by
`ios/Tests/CompanionCoreTests/HomeActivityRailLayoutPolicyTests.swift`.
TDD evidence: the focused policy test first failed to compile before the policy
was added (`cannot find 'HomeActivityRailLayoutPolicy' in scope`), then passed
3 XCTest cases after implementation. The focused presentation/preview filter
also passed 7 Swift Testing cases.

Final verification (all passed):

```sh
swift test --package-path ios --filter 'HomeActivityRailLayoutPolicyTests|HomeActivityPresentationTests|HomeActivityPreviewExpansionPolicyTests'
swift test --package-path ios
(cd ios && xcodegen generate)
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-pill-fix-final-debug-0901 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-pill-fix-final-release-0901 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
git diff --check
```

The full Swift run passed 700 XCTest cases with zero failures and 20 Swift
Testing cases in five suites (the prior 697 count increased by the three new
policy tests). Both simulator builds ended with `** BUILD SUCCEEDED **` using
Simulator SDK 26.5. The final logs are `/tmp/vbot-pill-fix-swift-final-0901.log`,
`/tmp/vbot-pill-fix-final-debug-0901.log`, and
`/tmp/vbot-pill-fix-final-release-0901.log`.

On iPhone 17 Pro simulator `334FC58E-19DA-460C-AC2A-1D34D7CAA916` (iOS 26.5,
dark, accessibility XXXL), the final Debug build was recaptured with Reduce
Motion on and off. Full-resolution inspection verified the capsule contains
`Quiet`/`No pending`, `1 active`/`Working now`, and `1 waiting`/`Review now` in
both collapsed and expanded states; the rail stays below the expanded panel
and does not cover roster rows. Replaced portable evidence:

```text
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/09-quiet-xxxl-reduce-motion-off.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/10-quiet-xxxl-reduce-motion-on.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/11-active-xxxl-reduce-motion-off.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/12-active-xxxl-reduce-motion-on.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/13-expanded-active-xxxl-reduce-motion-on.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/18-expanded-needs-xxxl-reduce-motion-on-post-preview-expansion-fix.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/19-expanded-needs-xxxl-reduce-motion-off-post-preview-expansion-fix.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/24-expanded-active-xxxl-reduce-motion-off-post-preview-expansion-fix.png
```

No signing, upload, deploy, merge, or device release action was attempted.

## Final activity/island arbitration fix

Date: 2026-09-01 (America/Chicago)
Starting commit: `4c6da5d fix(ios): contain accessibility activity rail`

The remaining Important interaction finding is closed. `ChatListView` now
owns a small `HomeActivityArbitrationPolicy` state: an expanded activity panel
suppresses the needs-you island and its dismissal layer, while the normal
island dismissal layer is installed by the parent below the `safeAreaInset`
activity rail. The rail therefore keeps its reserved expanded height and its
collapsed button always wins the first tap; collapsing the panel re-reconciles
the pending needs-you card. The island shell and VoiceOver labels remain
unchanged in the normal collapsed/expanded flow, with no geometry offsets.

TDD evidence: `HomeActivityArbitrationPolicyTests` was first run before the
policy existed and failed to compile (`cannot find 'HomeActivityArbitrationPolicy'`),
then passed four state-transition tests after implementation.

Final verification (all passed):

```sh
swift test --package-path ios --filter 'HomeActivityArbitrationPolicyTests|HomeActivityPresentationTests|HomeActivityPreviewExpansionPolicyTests'
swift test --package-path ios
(cd ios && xcodegen generate)
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-arbitration-debug-final-0901 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-arbitration-release-final-0901 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
git diff --check
```

The focused gate passed four XCTest cases and seven Swift Testing cases. The
full Swift gate passed 704 XCTest cases with zero failures and 20 Swift Testing
cases in five suites. Both unsigned simulator builds ended with
`** BUILD SUCCEEDED **`; logs are `/tmp/vbot-arbitration-focused-final-0901.log`,
`/tmp/vbot-arbitration-swift-final-0901.log`,
`/tmp/vbot-arbitration-debug-final-0901.log`, and
`/tmp/vbot-arbitration-release-final-0901.log`.

On the iPhone 17 Pro simulator (iOS 26.5, dark appearance, accessibility
XXXL), the final Debug build was exercised with
`-store-preview -preview-expand-activity`. Tapping the collapsed activity rail
while the needs-you island was expanded opened the activity panel instead of
dismissing the island; the island disappeared immediately. The pending card
returned after collapsing the panel, preserving normal island behavior. Full-
resolution (1206 x 2622) screenshots were recaptured and inspected:

```text
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/18-expanded-needs-xxxl-reduce-motion-on-post-preview-expansion-fix.png
ios/AppStore/screenshots/task-4-home-activity-2026-08-31/19-expanded-needs-xxxl-reduce-motion-off-post-preview-expansion-fix.png
```

Both captures show the readable `NEEDS YOU` heading, Scout row, and complete
request detail with no island overlap. Reduce Motion on/off were each set
explicitly; the off capture retains the expected glass material effect but all
copy remains readable. No signing, upload, deploy, merge, or production
resource change was attempted.

## Home activity layout regression rerun

Date: 2026-09-01 (America/Chicago)
Starting commit: `a1e3ec8 fix(ios): retry read receipts and remove quiet inset`

The activity rail now participates in the home `VStack` below the roster
`ScrollView`; quiet state omits the rail entirely, so it contributes no bottom
inset. Expanded panel height is content-hugging for regular text sizes and
reserves a 260-point accessibility budget for active work (400 points remains
for needs-you details). The panel remains a vertical `ScrollView`, and the
collapsed button stays content-hugging while retaining one tap target.

Verification:

```sh
swift test --package-path ios --filter 'HomeActivityRailLayoutPolicyTests|HomeActivityArbitrationPolicyTests|HomeActivityPresentationTests|HomeActivityPreviewExpansionPolicyTests'
swift test --package-path ios
(cd ios && xcodegen generate)
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Debug \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-activity-debug-0901 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -sdk iphonesimulator -configuration Release \
  -destination 'platform=iOS Simulator,id=334FC58E-19DA-460C-AC2A-1D34D7CAA916' \
  -derivedDataPath /tmp/vbot-activity-release-0901 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
git diff --check
```

Focused tests passed (9 XCTest + 10 Swift Testing); full Swift tests passed
707 XCTest cases with zero failures and 23 Swift Testing cases. XcodeGen and
unsigned Debug/Release simulator builds passed on iOS Simulator SDK 26.5.

Current portable captures are in
`ios/AppStore/screenshots/task-4-home-activity-2026-09-01/` (iPhone 17 Pro,
iOS 26.5, dark): quiet, active, and expanded active at `large` and
accessibility XXXL. Full-resolution inspection confirms the quiet screen has
no activity rail or reserved inset, compact active rails remain below the last
visible roster row, and expanded active panels reserve stack space without
blurring or covering rows. The accessibility expanded panel keeps the enlarged
Forge row readable; remaining roster content is reachable by scrolling.
