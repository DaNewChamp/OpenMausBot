# Task 4 integrated visual and release gate

Date: 2026-08-31 (America/Chicago)
Branch: `feat/vbot-ios-home-activity-0831`
Starting commit: `5f05fed fix(ios): gate cursor-only work cards`

## Status

The simulator and core release gates passed. Home activity states that the
existing StorePreview fixture can represent were captured and inspected. No
product code was changed during this gate. TestFlight upload, signed export,
and physical-device verification remain intentionally out of scope here.

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

## States not produced

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
