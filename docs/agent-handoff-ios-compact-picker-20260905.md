# V Bot iOS compact model picker and call polish, September 5, 2026

## Release identity

Code commit: `1016b713bb406a786df98f96f4dc28bd359417a8`.
Branch: `feat/vbot-ios-agent-call-0904`, pushed to both `personal` (DaNewChamp/OpenMausBot) and `vbot-private` (DaNewChamp/VBot).
Version: **1.0.0 (91)** in the app, widgets, and share extension.
Primary worktree: `/Users/Vincent/Github/.worktrees/vbot-ios-agent-call-0904`.
Base: `c98c779d`, the prior build 90 call release. The separate fleet branch remains at `21fdc8fc`; no main or fleet merge was performed.

## Implemented

The normal OpenAI and Claude picker surfaces show four model families, with the full remaining catalog behind More models and search. Provider tabs browse only. Model, reasoning, Thinking, same-model Fast generation, and context settings are draft-only until one Apply action. Cancel or swipe-dismiss discards the draft. Chat and profile share the same sheet; provider tabs remain outside the scrolling choices.

Run via is an explicit source menu. Exact `(instanceId, modelId)` identity prevents duplicate Codex/Droid/Cursor rows from selecting the wrong engine. Choosing a family unavailable on the current source requires an explicit source choice before Apply. Current unavailable models remain represented rather than auto-substituted. Busy/offline/remote-selection changes, source permissions, pending mismatched families, and connection changes block unsafe writes. A stale sheet from another connection must be reopened, not silently rebound to another hub.

The variant resolver only selects exact advertised IDs. It does not synthesize IDs or silently reset another option to force a combination. Unsupported combinations are disabled; Advanced details exposes exact advertised variants when necessary. Reasoning can be a source capability or encoded in a model ID. Changing to encoded reasoning clears obsolete separate effort, while simply opening an existing selection does not rewrite it.

Thinking does not imply 1M context. A context toggle appears only for unambiguous standard/1M ID counterparts. When all variants explicitly identify 1M in their labels or IDs, the picker says 1M included. Mixed/missing label metadata is not treated as proof of a smaller context. The captured native Codex catalog has no separate Sol -1m ID; no fake toggle was created for it. NO ZDR/privacy notes stay with the selected execution variant.

The old `bot.fastMode` still invokes the existing auto-router, which can change engines/models and reasoning. It is now called Auto-pick a faster model, in Advanced with honest explanatory copy. The new Fast generation control selects a Fast variant of the same model and source and never writes that auto-router boolean.

Call polish removes repeated phase chirps; there is no placebo sound toggle and no claim of custom sound design in this release. Phase/interaction haptics are restrained and avoid active microphone listening. The orb uses actual mic/playback values, non-audio thinking motion, and distinct muted/reconnecting presentation. Microphone mute no longer hides the agent playback amplitude. Reduce Motion and inactive-scene behavior limit continuous animation; the redundant outer TimelineView was removed.

Call voice is available from the bot profile as well as the call. A short suggested list precedes collapsed More voices/search. Cancel and Apply affect only the per-bot phone voice preference. On-device preview is disabled during an active call; outside a call it uses the existing LocalTtsEngine, with task generation/cancellation, interruption, disappearance, and scene lifecycle guards. Locale normalization handles en_US as well as en-US. No endpoint credentials appear in the voice picker.

## Tests and review

Baseline: 955 XCTest + 46 Swift Testing tests, zero failures.
Final: **1,008 XCTest + 46 Swift Testing = 1,054 tests**, zero failures.
Final log: `/tmp/vbot-picker-release-swift-0905.log` on the mini.
`git diff --check` and staged diff check passed before commit.

The known-fields live catalog is checked in at `ios/Tests/CompanionCoreTests/Fixtures/model-catalog-20260905.json`. It contains no CLI, API key, installation, or environment fields. SHA-256: `6e87829871a95147da9853a79015a17595a7740513f8e3d322838643cfc1ee03`. Captured counts were 93 OpenAI and 108 Claude rows; most expanded variants came from Cursor. Tests roundtrip every advertised source/model tuple without constructing model IDs. The fixture is not included in the Release IPA.

Root regression red evidence:
- `/tmp/vbot-picker-root-regression-red-0905.log`: draft, source, effort, context, identity regressions reproduced and then fixed.
- `/tmp/vbot-voice-root-red-0905.log`: mute/playback amplitude and underscored locale regressions reproduced and fixed.
- `/tmp/vbot-picker-review-red-0905.log`: unchanged unavailable selection falsely reported invalid; now retained without that false error.

Grok 4.6 High initial picker worker timed out; root finished, corrected and independently verified the patch. AGY Flash implemented the isolated call polish, followed by root hardening. The independent safe plaintext review is `/tmp/vbot-picker-independent-review-0905.log`. Review dispositions:
- Automatically resetting conflicting variant axes was rejected: unsupported combinations must be disabled, not silently changed; exact variant selection is available in Advanced.
- Unchanged unavailable selection error was real and fixed with a regression.
- First hydration now checks draft identity/effort before initialization; normal refresh never resets the draft.
- A newly connected/different hub is not silently adopted; reopening is required with explicit copy.
- Cross-provider family selection is deliberately pending until source selection; real simulator interaction verified it.
- Voice preview cancellation now also handles audio interruption and active-call changes, in addition to LocalTtsEngine interruption handling.

## Actual simulator verification

MacBook Xcode 27 beta; iPhone 17 Pro simulator `950CA8A6-FCBA-435E-92FA-3F6780921607`.
QA worktree: `/Users/vincent/Projects/VBotRelease-picker-0905` (task snapshot; left intact).
Combined Debug build/install/launch passed. Final combined build log:
`/Users/vincent/Library/Developer/XcodeBuildMCP/workspaces/vincent-54f62e1edb3b/logs/build_run_sim_2026-09-05T13-28-01-094Z_pid59821_80f5f34f.log`.

The DEBUG-only local picker preview loaded the captured catalog from its Documents directory. No live bot, credentials, pairing, or network client was used. Real UI taps proved provider browsing did not alter the saved selection; selecting a different-provider family required Run via; Cancel restored Codex Sol; selecting Cursor, toggling Fast and pressing Apply produced exactly `cursor / gpt-5.6-sol-medium-fast`, with one apply, and displayed 1M included. Light and dark layouts were visually inspected; normal lists have four rows and correctly labeled compact Run via/Reasoning controls.

StorePreview call QA with the diagnostic amplitude probe visually checked the orb, mute transition, timer, hang-up controls, and the voice sheet with disabled preview during a call. This is UI/fixture evidence, not physical microphone, Bluetooth, haptic, background-call, or real agent speech proof. The simulator app was terminated after QA, so no preview call remains active.

MacBook screenshots:
- `/Users/vincent/Archives/VBot-picker-0905-qa/picker-cursor-fast-one-apply.png`
- `/Users/vincent/Archives/VBot-picker-0905-qa/call-voice-muted-preview-blocked.png`

## Signed artifacts

Clean MacBook release worktree: `/Users/vincent/Projects/VBotRelease-picker91-0905`, branch `release/picker91-0905`, exact code commit `1016b713`.
Generated project: `ios/OpenMausCompanion.xcodeproj`, scheme `OpenMausCompanion`.
Signed Release archive succeeded using stable Xcode / iOS 26.2 SDK:
`/Users/vincent/Archives/VBot-1.0.0-91.xcarchive`.
Locked-phone discovery warnings did not fail the generic archive and were not bypassed.

App Store export succeeded:
`/Users/vincent/Archives/VBot-1.0.0-91-export/OpenMausCompanion.ipa`.
Size: 9,716,659 bytes.
SHA-256: `8543bca4e66fa3680a3f4d720acdc56ce29ebcf41e495be69f93e0f6af8e4933`.
All three bundle versions were independently checked as 1.0.0 (91), and the captured fixture was verified absent from the IPA. The exported IPA was independently unpacked to a disposable verification directory; `codesign --verify --deep --strict` passed, its signer was Apple Distribution: VINCENT LEWIS POSIVAL (LT58RNRW7E), and `get-task-allow=false`. The disposable verification directory was removed afterward.
Export options: `/Users/vincent/Archives/VBot-picker91-ExportOptions.plist`, `destination=export`, `testFlightInternalTestingOnly=true`, `manageAppVersionAndBuildNumber=false`.

## Apple delivery state: VALID, internal-only

**Build 91 completed upload and processing successfully.** Official Apple altool returned `UPLOAD SUCCEEDED with no errors` and `build-status=VALID`. A separate `ios_testflight_build_status` query using the returned delivery UUID independently confirmed:

- App `6805160831`, version `1.0.0 (91)`.
- Delivery UUID: `20e3cd3f-4a8d-404c-8680-2f784a0dad11`.
- `build-status=VALID`, `import-status=VALID`, `processingState=VALID`.
- `buildAudienceType=INTERNAL_ONLY`, `is-on-app-store-connect=true`.
- Non-exempt encryption false, not expired.
- Apple reports upload date September 5, 2026 at 08:53:02 CDT.

Managed job `20260905T134203-command-c7755a10` is terminal completed, exit 0; elapsed 730.544 seconds. Apple analysis was quiet for about ten minutes before the transfer; it was not treated as failure and no duplicate upload was attempted. The actual file transfer was 9,716,659 bytes in 0.576 seconds.

MacBook log: `/tmp/vbot-picker91-upload-0905.log`.
Mini bridged log: `/tmp/vbot-picker91-upload-bridge-0905.log`.
The single command used official `altool --upload-package ... --wait --output-format json` with the already configured App Store Connect credential. Both its JSON and the separate status query were inspected, rather than trusting only a wrapper success flag.

Internal group access was not changed or independently re-read in this session; prior release history records the Vi internal group as having access to all builds. The live evidence here proves VALID and INTERNAL_ONLY, not a new group-assignment write.

Reusable lesson: the status helper works when passed the actual returned delivery UUID. Its older apple-id/version-only path rejects the request without delivery-id; the app-list helper returns only app metadata. Do not confuse asset-upload/request UUIDs with a delivery ID or retry manual private-key/JWT extraction. Use the official Apple tools and established credential lane.

## Preserved state / boundaries

No main merge, production hub/sidecar/bridge restart, web deploy, permanent bot mutation, fleet reassignment, Docker operation, dependency update, or new APNs entitlement. Root OpenMausBot unrelated dirty Peekaboo/build/docs work remains untouched. The isolated voice worker tree `/Users/Vincent/Github/.worktrees/vbot-ios-mobile-parity-0904` retains its original uncommitted reviewed patch; its worker is terminal, and final code lives in the committed primary tree. No cleanup/reset was used to hide that state.

Closed-app APNs and the separate mobile Computer Activity timeline are not part of this release. Physical call audio/haptic/background soak remains unproved by this session; do not infer it from policy tests or the simulator amplitude probe.
