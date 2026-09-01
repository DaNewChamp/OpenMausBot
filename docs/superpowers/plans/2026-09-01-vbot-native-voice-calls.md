# V Bot Native iPhone Voice Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-party V Bot foreground iPhone half-duplex voice MVP for 1:1 bots and team rooms by reusing Apple on-device speech recognition, the existing paired chat/SSE/TTS path, tap interrupt, 850ms silence endpointing, group turn sequencing, and spoken yes/no approvals.

**Architecture:** The phone is only the microphone, speaker, and call surface. Capture uses in-process `SFSpeechRecognizer` on `AVAudioEngine` with the mic closed during playback because this recognizer has no acoustic echo cancellation. Final transcripts go through the existing companion `Client.send` / `respond` / `interrupt` APIs; the Hub folds replies, `tool.spoken` narration, and approval cards over the existing SSE stream; `/api/tts/prepare` plus `/api/tts/speak` stay on the Hub so credentials never reach the phone. Team calls queue one member at a time and route spoken names onto the room's existing `@mention` syntax. Full duplex stays deferred until a proven AEC capture path exists. Kokoro is the next Hub TTS provider, not part of this MVP.

**Tech Stack:** Swift 6 / SwiftUI / Speech / AVFoundation, CompanionCore (Foundation-only policies + HTTP), existing Node companion allowlist, Hub `server/tts/*` and `/api/events`, zero new dependencies.

## Global Constraints

- Clean-room original V Bot UI and copy only; do not copy proprietary Grok Bot code, routes, or assets.
- No new npm, Swift, or system dependencies. No ONNX, no phone-side Kokoro, no ElevenLabs Agents, no OpenAI Realtime, no Gemini Live.
- Do not add, remove, or upgrade packages in this plan.
- Half-duplex only: the microphone is live only when the bot is not speaking, except while a spoken approval/question is waiting for a yes/no or an answer.
- Do not leave the mic open during TTS playback. Full-duplex barge-in is out of scope until a proven AEC capture path exists and is tested on device.
- Foreground iPhone only. No CallKit, no background VoIP, no lock-screen continuation. Background, lock, audio interruption, revoked pairing, or leaving the chat hangs up and releases the mic.
- Apple on-device recognition when `supportsOnDeviceRecognition` is true; never send call audio to a cloud STT. Composer dictation stays press-to-stop with no silence timeout.
- Reuse current chat, SSE, group send, interrupt, approval respond, and TTS prepare/speak. Do not invent a voice websocket or a second transcript store.
- TTS credentials stay on the Hub. The phone receives voice labels and audio bytes only.
- Bridges keep their current advertised capabilities (`shell`, `local-vm`, `ssh-forward`). Do not add a `tts` bridge capability in this MVP.
- Roleplay personas and local-model bots use the same send/SSE path as every other bot. Do not add a voice-only system prompt or a special engine.
- `com.posival.openmausmobile`, existing pairing, and composer dictation must keep working after hang-up.
- Feature-flag the iOS call button until the device exit criteria pass. Desktop calls stay unchanged.
- Do not deploy, change networking, or upload TestFlight without Vincent's explicit approval.

---

## Seams Inspected (do not re-audit)

Read-only pass on 2026-09-01. Implementers should treat these as the source of truth and extend them rather than inventing a parallel stack.

| Seam | Where it lives today | Call MVP implication |
| --- | --- | --- |
| Desktop 1:1 call | `src/components/CallView.tsx`, `src/lib/call.ts` | Phase loop is `listening → sending → working → speaking`. Mic closed during playback. Tap / Space interrupts. Escape hangs up. `CALL_ENDPOINT_MS = 850`. |
| Desktop team call | `src/components/GroupCallView.tsx`, `src/lib/group-call.ts` | One mic, queued member speech, `routeSpokenGroupMessage`, `busyBotId` gates listen, interrupt also POSTs group interrupt. DMs have no call button. Rooms require every member to have a voice. |
| Desktop STT | `electron/resources/speech-helper.swift` | Buffer-backed `SFSpeechRecognizer` does not finalize on silence; helper `--endpoint-ms` calls `endAudio()`. Intentional stops must not emit a final transcript. |
| Desktop TTS | `src/lib/tts/index.ts`, `server/tts/index.ts`, `server/index.ts` `/api/tts/prepare` + `/api/tts/speak` | Prepare splits utterances on the Hub. Speak returns opaque audio bytes. Prefetch utterance n+1 while n plays. Abortable. 500-char speak cap. |
| iOS STT | `ios/App/SpeechDictation.swift`, `ios/Sources/CompanionCore/Dictation.swift` | Composer only. Category `.record`. No silence endpointing. On-device when supported. `ChatView` already stops dictation on background, leave, and audio interruption. |
| iOS TTS | `Client.previewVoice` → `POST /api/tts/speak`; `AgentProfileView` plays with `AVAudioPlayer` | Preview exists. Prepare is missing on the iOS client. Companion allowlist has voices + speak, **not** prepare. |
| Chat / SSE | `Client.send` bot/room, `Client.interrupt`, `Client.respond`, `ios/Sources/CompanionCore/SSE.swift` | Call sends ordinary messages and folds ordinary frames. `Message.tool.spoken` is already decoded. |
| Group routing | `ios/Sources/CompanionCore/GroupRouting.swift`, `src/lib/group-routing.ts` | Composer `@mentions`. Spoken “Atlas, …” must be rewritten before send (`src/lib/group-call.ts` already does this on desktop). |
| Approvals | `Client.respond(threadId:requestId:behavior:message:)`, desktop YES/NO regex in `CallView.tsx` | Speak the card. Only clear yes/no grants or denies. Ambiguous speech re-asks. Non-permission questions take the next complete turn as the answer. |
| Capability / bridges | `server/bridge-registry.ts` `BridgeCapability = "shell" \| "local-vm" \| "ssh-forward"` | TTS is Hub-owned. Phones talk only to the companion. Do not place STT or TTS on a bridge in this MVP. |
| Flags | `src/lib/feature-flags.ts` | Experimental features are explicit opt-in (`skillRecorder`). iOS calls follow that pattern. |
| Voice decision doc | `docs/voice-mode.md` | Half-duplex rationale, 850ms endpointing, narration, spoken approvals, rejected realtime/S2S providers, Kokoro previously rejected as a **renderer** bundle. This plan places Kokoro later **on the Hub**, not on the phone. |
| Supersedes | `docs/superpowers/plans/2026-08-31-vbot-ios-parity-closeout.md` Task 5 | That task said “no room calls”. This plan requires team calls in the same MVP. |

Immediate backend blocker: `companion/src/routes.ts` allowlist includes `GET /api/tts/voices` and `POST /api/tts/speak` only. Desktop `Speaker.prepare` already POSTs `/api/tts/prepare`. The phone cannot split markdown into speakable utterances until that route is allowlisted.

---

## File Map

Create:

- `ios/Sources/CompanionCore/CallModePolicy.swift` — phase machine, availability, hang-up rules, approval speech, duplex guard.
- `ios/Sources/CompanionCore/GroupCallRouting.swift` — Swift port of `routeSpokenGroupMessage`.
- `ios/Sources/CompanionCore/CallSpeaker.swift` — Hub prepare/speak client (HTTP only, no AVFoundation).
- `ios/App/CallCapture.swift` — call-mode `SFSpeechRecognizer` with 850ms silence endpointing.
- `ios/App/CallAudioPlayer.swift` — `AVAudioPlayer` playback/interrupt for opaque TTS bytes.
- `ios/App/CallView.swift` — 1:1 overlay.
- `ios/App/GroupCallView.swift` — team overlay and speech queue.
- `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`
- `ios/Tests/CompanionCoreTests/GroupCallRoutingTests.swift`
- `ios/Tests/CompanionCoreTests/VoiceClientTests.swift`

Modify:

- `companion/src/routes.ts` and `companion/test/routes.test.ts` — allow `POST /api/tts/prepare`.
- `server/config.ts`, `server/index.ts` `configStatus()`, `src/lib/feature-flags.ts` — `iosVoiceCalls` opt-in, emitted on `GET /api/config` (already phone-readable; PATCH remains desktop-only).
- `server/config.test.ts`, `src/lib/feature-flags.test.ts`
- `ios/Sources/CompanionCore/Client.swift` — `prepareSpeech`.
- `ios/Sources/CompanionCore/Models.swift` — decode optional `ConfigStatus.features.iosVoiceCalls`.
- `ios/App/SpeechDictation.swift` is **not** modified. `CallCapture` calls `Dictation.localeCandidates()` directly.
- `ios/App/ChatView.swift`, `ios/App/ChatChromeView.swift`, `ios/App/Session.swift` — call button, overlay, hang-up on leave/background/pairing loss.
- `ios/project.yml` — purpose strings mention calls.
- `docs/voice-mode.md`, `docs/ios-companion.md`, `ios/TESTING.md` — current-state + device gates.
- `server/tts/index.ts` is **not** modified in MVP. Kokoro is Task 11 (next), after the phone loop works.

Do not create: CallKit providers, websocket voice routes, bridge `tts` capability, renderer Kokoro, or a second SSE stream.

---

## Interfaces (locked names)

```swift
public enum CallPhase: String, Equatable, Sendable {
    case idle, listening, sending, working, speaking, ended
}

public struct CallTarget: Equatable, Sendable {
    public var id: String
    public var threadId: String
    public var isRoom: Bool
    public var name: String
    public var voices: [String?]
}

public struct CallAvailability: Equatable, Sendable {
    public var flagged: Bool
    public var speechAvailable: Bool
    public var ttsConfigured: Bool
    public var voiceReady: Bool
    public var companionPrepareAllowed: Bool
    public var foreground: Bool
    public var paired: Bool
    public var reason: String
    public var canStart: Bool { flagged && speechAvailable && ttsConfigured && voiceReady && companionPrepareAllowed && foreground && paired }
}

public enum CallEvent: Equatable, Sendable {
    case start(CallTarget)
    case hangUp
    case capturePartial(String)
    case captureFinal(String)
    case captureFailed(String)
    case tapInterrupt
    case botBusy(Bool, speakerBotId: String?)
    case speakText(String, botId: String?, voiceId: String?, messageId: String?)
    case playbackFinished
    case backgrounded
    case pairingRevoked
}

public enum ApprovalSpeechDecision: Equatable, Sendable {
    case allow
    case deny
    case reask
}

public struct SpokenGroupMessage: Equatable, Sendable {
    public var text: String
    public var addressed: Bool
}

public struct PreparedSpeech: Equatable, Sendable {
    public var ready: Bool
    public var utterances: [String]
}
```

Hub/client HTTP (already exists except the allowlist + iOS prepare wrapper):

- `POST /api/tts/prepare` body `{ text, voiceId? }` → `{ ready, utterances }`
- `POST /api/tts/speak` body `{ text, voiceId? }` → audio bytes, max 500 characters
- `POST /api/bots/:id/messages` and `POST /api/groups/:id/messages`
- `POST /api/bots/:id/interrupt` and `POST /api/groups/:id/interrupt`
- `POST /api/threads/:id/respond` body `{ requestId, behavior, message? }`
- `GET /api/events` existing SSE

Desktop constants to copy, not reinvent:

- `CALL_ENDPOINT_MS = 850`
- Approval YES: `/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i`
- Approval NO: `/^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i`

---

### Task 1: Companion Prepare Allowlist and Feature Flag

**Files:**
- Modify: `companion/src/routes.ts` (allowlist near the existing TTS entries around lines 708–711)
- Modify: `companion/test/routes.test.ts` (allowed-route table around lines 141–142)
- Modify: `server/config.ts` (`featureConfigSchema` around line 67 and `AppConfig.features`)
- Modify: `server/index.ts` (`configStatus()` around line 4025)
- Modify: `server/config.test.ts`
- Modify: `src/lib/feature-flags.ts`
- Modify: `src/lib/feature-flags.test.ts`
- Modify: `ios/Sources/CompanionCore/Models.swift` (`ConfigStatus`)
- Test: `companion/test/routes.test.ts`
- Test: `src/lib/feature-flags.test.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: existing companion allowlist classifier `denyReason`, existing phone-readable `GET /api/config`.
- Produces: paired devices may `POST /api/tts/prepare`. `iosVoiceCallsEnabled(config)` is true only when `features.iosVoiceCalls === true`. Hub `configStatus().features` includes that boolean. Unauthenticated devices still cannot hit TTS. Phone still cannot PATCH `/api/config`.

- [ ] **Step 1: Write the failing allowlist and flag tests**

```ts
it("allows POST /api/tts/prepare", () => {
  expect(ask("POST", "/api/tts/prepare")).toBeNull();
});

it("still refuses config writes and credentials from the phone", () => {
  expect(ask("PATCH", "/api/config")?.error).toMatch(/API keys/i);
  expect(ask("GET", "/api/config")).toBeNull();
});

it("keeps iOS voice calls hidden by default", () => {
  expect(iosVoiceCallsEnabled(null)).toBe(false);
  expect(iosVoiceCallsEnabled({})).toBe(false);
  expect(iosVoiceCallsEnabled({ features: { iosVoiceCalls: true } })).toBe(true);
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm exec vitest run companion/test/routes.test.ts src/lib/feature-flags.test.ts server/config.test.ts`
Expected: FAIL because prepare is not allowlisted, `iosVoiceCallsEnabled` is undefined, and Hub config rejects/omits the flag.

- [ ] **Step 3: Add the allowlist entry and flag helper**

Add `{ method: "POST", path: /^\/api\/tts\/prepare$/ }` next to the existing TTS rows. Comment that the route returns utterance strings only, never the ElevenLabs key.

Add `iosVoiceCalls: z.boolean().optional()` to `featureConfigSchema`, `features?: { skillRecorder?: boolean; iosVoiceCalls?: boolean }` on `AppConfig`, and emit `iosVoiceCalls: iosVoiceCallsEnabled(cfg)` beside `skillRecorder` in `configStatus()`. Implement:

```ts
export function iosVoiceCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.iosVoiceCalls === true;
}
```

Keep a Hub helper in `server/config.ts` with the same default-false rule as `skillRecorderEnabled`. Extend `FeatureFlagConfig.features` with optional `iosVoiceCalls?: boolean`. Decode optional `features.iosVoiceCalls` on iOS `ConfigStatus` (unknown extra keys are already ignored). Do not default it on. The phone reads the flag from `GET /api/config`; the owner turns it on from desktop Settings / config PATCH, which stays Mac-only.

- [ ] **Step 4: Re-run the focused tests**

Expected: PASS. `GET /api/config` remains allowed (booleans only). `PATCH /api/config` and `/api/instances` still deny from the phone. Hub config accepts `{ features: { iosVoiceCalls: true } }` and defaults false.

- [ ] **Step 5: Commit**

Commit message: `feat(companion): allow TTS prepare for iOS calls`

---

### Task 2: Call Mode Policy (testable, no microphone)

**Files:**
- Create: `ios/Sources/CompanionCore/CallModePolicy.swift`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: `CallPhase`, `CallTarget`, `CallAvailability`, `CallEvent`, `ConfigStatus.canSpeak(agentVoice:)`.
- Produces: `CallModePolicy.reduce(phase:availability:event:) -> CallPhase` and `CallModePolicy.availability(...)`. Mic-open is true only in `listening`.

- [ ] **Step 1: Write failing policy tests**

```swift
func testMicIsClosedDuringPlaybackAndSending() {
    XCTAssertTrue(CallModePolicy.micOpen(phase: .listening, awaitingSpokenDecision: false))
    XCTAssertTrue(CallModePolicy.micOpen(phase: .listening, awaitingSpokenDecision: true))
    XCTAssertFalse(CallModePolicy.micOpen(phase: .speaking, awaitingSpokenDecision: false))
    XCTAssertFalse(CallModePolicy.micOpen(phase: .sending, awaitingSpokenDecision: false))
    XCTAssertFalse(CallModePolicy.micOpen(phase: .working, awaitingSpokenDecision: false))
}

func testBusyClosesMicUnlessASpokenApprovalIsOpen() {
    XCTAssertEqual(
        CallModePolicy.reduce(phase: .listening, awaitingSpokenDecision: false, event: .botBusy(true, speakerBotId: "b1")),
        .working
    )
    XCTAssertEqual(
        CallModePolicy.reduce(phase: .listening, awaitingSpokenDecision: true, event: .botBusy(true, speakerBotId: "b1")),
        .listening
    )
}

func testTapInterruptLeavesSpeakingAndReopensListen() {
    XCTAssertEqual(
        CallModePolicy.reduce(phase: .speaking, awaitingSpokenDecision: false, event: .tapInterrupt),
        .listening
    )
}

func testBackgroundLockAndRevokedPairingHangUp() {
    for event: CallEvent in [.backgrounded, .pairingRevoked, .hangUp] {
        XCTAssertEqual(CallModePolicy.reduce(phase: .listening, awaitingSpokenDecision: false, event: event), .ended)
        XCTAssertFalse(CallModePolicy.micOpen(phase: .ended, awaitingSpokenDecision: true))
    }
}

func testCallButtonHiddenUntilFlagVoiceAndSpeechAreReady() {
    let blocked = CallModePolicy.availability(
        flagged: false,
        speechAvailable: true,
        ttsConfigured: true,
        agentVoice: "voice-1",
        workspaceDefaultVoice: true,
        requireEveryMemberVoice: false,
        memberVoices: ["voice-1"],
        companionPrepareAllowed: true,
        foreground: true,
        paired: true
    )
    XCTAssertFalse(blocked.canStart)

    let ready = CallModePolicy.availability(
        flagged: true,
        speechAvailable: true,
        ttsConfigured: true,
        agentVoice: "voice-1",
        workspaceDefaultVoice: false,
        requireEveryMemberVoice: false,
        memberVoices: ["voice-1"],
        companionPrepareAllowed: true,
        foreground: true,
        paired: true
    )
    XCTAssertTrue(ready.canStart)
}

func testRoomCallRequiresEveryMemberVoice() {
    let missing = CallModePolicy.availability(
        flagged: true,
        speechAvailable: true,
        ttsConfigured: true,
        agentVoice: nil,
        workspaceDefaultVoice: true,
        requireEveryMemberVoice: true,
        memberVoices: ["alpha-voice", nil],
        companionPrepareAllowed: true,
        foreground: true,
        paired: true
    )
    XCTAssertFalse(missing.canStart)
    XCTAssertTrue(missing.reason.contains("every"))
}

func testFullDuplexIsRejected() {
    XCTAssertFalse(CallModePolicy.allowsOpenMicDuringPlayback)
}
```

- [ ] **Step 2: Run the suite and confirm failures**

Run: `swift test --package-path ios --filter CallModePolicyTests`
Expected: FAIL because `CallModePolicy` does not exist.

- [ ] **Step 3: Implement the minimal reducer**

Keep it pure. `allowsOpenMicDuringPlayback` is a `static let` of `false` so a future AEC patch has to change an explicit flag and the test above. Room availability copies desktop `requireExplicitVoices`: workspace fallback is not enough when several members speak.

- [ ] **Step 4: Re-run the suite**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add half-duplex call policy`

---

### Task 3: Spoken Approvals and Group Address Routing

**Files:**
- Create: `ios/Sources/CompanionCore/GroupCallRouting.swift`
- Modify: `ios/Sources/CompanionCore/CallModePolicy.swift` (approval speech helpers)
- Test: `ios/Tests/CompanionCoreTests/GroupCallRoutingTests.swift`
- Modify: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: desktop `routeSpokenGroupMessage` contract and the YES/NO regexes.
- Produces: `GroupCallRouting.route(text:members:) -> SpokenGroupMessage` and `CallModePolicy.approvalDecision(from:)`.

- [ ] **Step 1: Write failing routing and approval tests**

Port the exact cases from `src/lib/group-call.test.ts`:

```swift
func testSpokenNameBecomesMention() {
    let members = [GroupCallRouting.Member(id: "atlas", name: "Atlas"),
                   GroupCallRouting.Member(id: "research", name: "Deep Research")]
    XCTAssertEqual(GroupCallRouting.route(text: "Atlas, can you take this?", members: members).text,
                   "@Atlas can you take this?")
    XCTAssertEqual(GroupCallRouting.route(text: "Hey Deep Research: find the source", members: members).text,
                   "@Deep Research find the source")
    XCTAssertEqual(GroupCallRouting.route(text: "Everyone, give me your view", members: members).text,
                   "@everyone give me your view")
    XCTAssertEqual(GroupCallRouting.route(text: "What should we build next?", members: members).addressed, false)
}

func testApprovalYesNoOnly() {
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "yes"), .allow)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "nope"), .deny)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "sure, and also delete the folder"), .reask)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "please look at the logs"), .reask)
}
```

Mentions-mode rooms: if `addressed == false`, do not send; the UI asks the user to name a member or say “everyone”. Lead-bot rooms send unaddressed speech to the default responder, matching desktop `GroupCallView.tsx`.

- [ ] **Step 2: Run focused tests**

Run: `swift test --package-path ios --filter GroupCallRoutingTests --filter CallModePolicyTests`
Expected: FAIL on missing `GroupCallRouting` / approval helper.

- [ ] **Step 3: Implement the port**

Copy the desktop regex behavior, including longest-name-first so “Deep Research” wins over “Deep”. Approval matching is whole-utterance prefix, not a substring search, so “sure” inside a longer sentence cannot grant.

Spoken approval copy (1:1): `"{name} wants to {tool}. {detail}. Should I allow it?"`
Spoken question copy: `"{name} asks: {detail}. The options are {options}."`
Reask copy: `"Sorry — is that a yes or a no?"`
Deny message: `"Denied by the user, on a call."` (group: `"Denied by the user, on a group call."`)

- [ ] **Step 4: Re-run focused tests**

Expected: PASS. Also run `pnpm exec vitest run src/lib/group-call.test.ts` and keep both tables in sync if you have to tweak a case.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): route spoken group turns and approvals`

---

### Task 4: TTS Prepare Client and Playback Contract

**Files:**
- Create: `ios/Sources/CompanionCore/CallSpeaker.swift`
- Modify: `ios/Sources/CompanionCore/Client.swift` (add `prepareSpeech` next to `previewVoice` around line 1532)
- Create: `ios/App/CallAudioPlayer.swift`
- Test: `ios/Tests/CompanionCoreTests/VoiceClientTests.swift`

**Interfaces:**
- Consumes: `POST /api/tts/prepare` and `POST /api/tts/speak`.
- Produces: `Client.prepareSpeech(text:voiceId:) async throws -> PreparedSpeech`. `CallSpeaker` prefetches utterance n+1, aborts on `stop()`, and never holds the ElevenLabs key.

- [ ] **Step 1: Write failing HTTP tests**

```swift
func testPreparePostsTextAndVoice() async throws {
    // Stub URLProtocol: POST /api/tts/prepare body {"text":"Hello **world**","voiceId":"v1"}
    // Response {"ready":true,"utterances":["Hello world"]}
}

func testSpeakRejectsOversizeUtterancesBeforeTheWire() {
    XCTAssertThrowsError(try CallSpeaker.assertSpeakable("x".padding(toLength: 501, withPad: "x", startingAt: 0)))
}

func testStopAbandonsPrefetch() async {
    // Second utterance must not play after stop().
}
```

Use the same URLProtocol stub pattern as `Wave35ClientTests` / existing client tests. Do not hit a live Hub.

- [ ] **Step 2: Run `swift test --package-path ios --filter VoiceClientTests`**

Expected: FAIL.

- [ ] **Step 3: Implement prepare + speaker**

`Client.prepareSpeech` POSTs `/api/tts/prepare` with `{ text, voiceId }` and decodes `{ ready, utterances }`. If `ready == false`, surface the existing 409-style copy: pick a voice / add a key on the computer. `previewVoice` remains for the profile sheet.

`CallSpeaker` algorithm, copied from `src/lib/tts/index.ts`:

1. `stop()` bumps a generation token and aborts in-flight requests.
2. Prepare once.
3. Render utterance 0; while it plays, render utterance 1; continue.
4. Resolve when finished, interrupted, or failed. Failures set an error string; they do not crash the call.

`CallAudioPlayer` (App target) plays the returned `Data` with `AVAudioPlayer`, matching `AgentProfileView`. Session category while a call is alive is `.playAndRecord` with voiceChat / spokenAudio as needed, then deactivated on hang-up so composer dictation can return to `.record`.

- [ ] **Step 4: Re-run VoiceClientTests**

Expected: PASS. `swift test --package-path ios` still passes (App target is not in this package).

- [ ] **Step 5: Commit**

Commit message: `feat(ios): reuse Hub TTS prepare and speak`

---

### Task 5: Call Capture With Automatic Silence

**Files:**
- Create: `ios/App/CallCapture.swift`
- Do not modify: `ios/App/SpeechDictation.swift`
- Test: document simulator/device gate in `ios/TESTING.md` (updated in Task 10). Logic that can be tested without Speech stays in `CallModePolicy.endpointMs`.

**Interfaces:**
- Consumes: `Dictation.localeCandidates()`, `CallModePolicy.endpointMs == 850`.
- Produces: `CallCapture.start()`, `stop(intentional:)`, `onPartial`, `onFinal`. Intentional stop does not emit `onFinal`.

- [ ] **Step 1: Lock the capture contract in policy tests**

```swift
func testCallEndpointIs850MsAndComposerHasNone() {
    XCTAssertEqual(CallModePolicy.endpointMs, 850)
    XCTAssertEqual(CallModePolicy.composerEndpointMs, 0)
}

func testIntentionalStopDoesNotCountAsAUserTurn() {
    XCTAssertFalse(CallModePolicy.shouldSend(finalText: "", intentionalStop: false))
    XCTAssertFalse(CallModePolicy.shouldSend(finalText: "hello", intentionalStop: true))
    XCTAssertTrue(CallModePolicy.shouldSend(finalText: "hello", intentionalStop: false))
}
```

- [ ] **Step 2: Run those tests**

Expected: FAIL until the constants exist.

- [ ] **Step 3: Implement `CallCapture`**

Follow `SpeechDictation` generation tokens, authorization, and cancellation-code handling (`kLSRErrorDomain` 209/216, `kAFAssistantErrorDomain` 216). Differences from composer:

- `request.taskHint = .dictation` still, `addsPunctuation = true`, `requiresOnDeviceRecognition` when supported.
- Silence timer: after a non-empty transcript is unchanged for 850ms (clamp 250...5000 like the desktop helper), stop the engine tap, `endAudio()`, and wait for `isFinal`.
- Empty finals restart listening; they do not send.
- Category: `.playAndRecord` because the call must be able to speak next. Composer remains `.record`.
- `stop(intentional: true)` on hang-up, interrupt, or playback start: cancel the task, do not publish a final.

If on-device recognition is unavailable, fail closed with “Calls need on-device speech recognition on this iPhone.” Do not fall back to Apple cloud STT for call audio.

- [ ] **Step 4: Confirm composer dictation is unchanged**

`git diff ios/App/SpeechDictation.swift` is empty. Composer still has no `endpointMs` and remains press-to-stop. `CallCapture` uses `Dictation.localeCandidates()` from CompanionCore.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add silence-endpointed call capture`

---

### Task 6: 1:1 Foreground Call UI

**Files:**
- Create: `ios/App/CallView.swift`
- Modify: `ios/App/ChatChromeView.swift`
- Modify: `ios/App/ChatView.swift`
- Modify: `ios/App/Session.swift`

**Interfaces:**
- Consumes: Tasks 2–5, `Client.send(text:toBot:)`, SSE-folded messages, `bot.busy`, `tool.spoken`.
- Produces: one call at a time on `Session.currentCallId`. Overlay with avatar, phase label, caption, Interrupt, Hang up.

- [ ] **Step 1: Add session ownership tests if a pure store helper exists; otherwise extend `CallModePolicy`**

```swift
func testStaleHangUpCannotKillANewerCall() {
    var current: String? = "bot-a"
    current = CallModePolicy.transfer(current: current, to: "bot-b")
    XCTAssertEqual(current, "bot-b")
    XCTAssertFalse(CallModePolicy.end(current: current, targetId: "bot-a"))
}
```

Mirror `src/lib/call.test.ts`.

- [ ] **Step 2: Run the ownership tests**

Expected: FAIL until transfer/end helpers exist.

- [ ] **Step 3: Wire the 1:1 overlay**

Loop, matching desktop `CallView.tsx`:

1. Start: if `bot.busy` and no open approval/question → `working`; else `listening` + `CallCapture.start()`.
2. Partial transcripts update the caption. Final non-empty text → `sending` + `Client.send`.
3. SSE: newest unseen `kind == text` bot reply is spoken; during `working`, newest unseen `tool.spoken` is spoken then return to `working`; do not recite the backlog present at start.
4. `bot.busy` true → close mic unless a spoken approval is open.
5. After playback finishes and the bot is not busy → listen again.
6. Tap Interrupt: `CallSpeaker.stop()`, `CallCapture.start()`, phase `.listening`. Do **not** POST `/interrupt` on a 1:1 tap unless the bot is still `busy` after speech stopped and the product copy says so. Desktop 1:1 interrupt only stops local TTS and reopens the mic; keep that. Group interrupt is Task 8.
7. Hang up / Back / `scenePhase != .active` / `AVAudioSession` interruption / pairing loss → `ended`, stop capture, stop speaker, deactivate session.
8. Call button sits in chat chrome next to the existing overflow. Disabled state uses `CallAvailability.reason` (flag off, no voice, no speech, not foreground). DMs that are 1:1 bots use this view; `group.dm == true` rooms do not get a team call button.

Original V Bot visuals: existing `MausAvatar`, liquid-glass hang-up, no Grok Bot assets. VoiceOver labels: “Call {name}”, “Hang up”, “Interrupt {name}”.

- [ ] **Step 4: Simulator compile**

Run unsigned Debug simulator build for the app target after XcodeGen. `swift test --package-path ios` passes. Microphone quality remains a device gate.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add foreground 1:1 bot calls`

---

### Task 7: Spoken Approval and Question Handling in the Call

**Files:**
- Modify: `ios/App/CallView.swift`
- Modify: `ios/App/GroupCallView.swift` (once Task 8 exists, land the shared helper in Task 7 and use it in both)
- Modify: `ios/App/Session.swift` if respond/alwaysAllow need a call-specific wrapper
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: `CallModePolicy.approvalDecision`, `Client.respond(threadId:requestId:behavior:message:)`.
- Produces: permission cards spoken and answered with allow/deny only; non-permission `options` cards spoken and answered with the next complete user turn.

- [ ] **Step 1: Add failing card-state tests**

```swift
func testPermissionCardKeepsMicOpenWhileBusy() {
    let phase = CallModePolicy.reduce(
        phase: .working,
        awaitingSpokenDecision: true,
        event: .botBusy(true, speakerBotId: "b1")
    )
    XCTAssertEqual(phase, .listening)
}

func testResolvedCardDoesNotKeepFutureSpeechAsConsent() {
    XCTAssertFalse(CallModePolicy.shouldTreatSpeechAsApproval(askedRequestId: "r1", currentRequestId: nil))
}
```

- [ ] **Step 2: Run the tests**

Expected: FAIL until those helpers exist.

- [ ] **Step 3: Implement the desktop card loop**

When an unseen permission card appears and phase is not `speaking`, speak the approval prompt, set `awaitingSpokenDecision`, then listen. Yes → `respond(..., behavior: "allow")`. No → `respond(..., behavior: "deny", message: "Denied by the user, on a call.")`. Anything else → speak the reask line and listen again. If another client answers the card, clear `askedRequestId`.

Non-permission questions: speak the prompt + options, then the next final transcript is `respond(..., behavior: "answer", message: said)`.

Do not route approval speech through `alwaysAllow`. Do not infer consent from a sentence that merely contains “sure”.

- [ ] **Step 4: Re-run policy tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): speak and answer call approvals`

---

### Task 8: Team Calls and Turn Sequencing

**Files:**
- Create: `ios/App/GroupCallView.swift`
- Modify: `ios/App/ChatChromeView.swift`, `ios/App/ChatView.swift`, `ios/App/Session.swift`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: `GroupCallRouting.route`, `Client.send(text:toRoom:)`, `Client.interrupt(roomId:)`, `room.busyBotId`, per-member `bot.voice`.
- Produces: one queued speaker at a time; a fast second member cannot cut off the first except via tap interrupt.

- [ ] **Step 1: Write failing queue tests**

```swift
func testGroupSpeechQueueIsFIFO() {
    var queue = CallModePolicy.SpeechQueue()
    queue.enqueue("working", botId: "a")
    queue.enqueue("done", botId: "b")
    XCTAssertEqual(queue.next()?.botId, "a")
    XCTAssertEqual(queue.next()?.botId, "b")
}

func testInterruptDropsTheQueueAndFlagsListen() {
    var queue = CallModePolicy.SpeechQueue()
    queue.enqueue("hello", botId: "a")
    queue.interrupt()
    XCTAssertNil(queue.next())
}

func testMentionsRoomRefusesUnaddressedSpeech() {
    XCTAssertTrue(CallModePolicy.requiresAddress(defaultResponderKind: "mentions"))
    XCTAssertFalse(CallModePolicy.requiresAddress(defaultResponderKind: "member"))
}

func testDmRoomsHaveNoTeamCall() {
    XCTAssertFalse(CallModePolicy.allowsRoomCall(isDm: true))
}
```

- [ ] **Step 2: Run the tests**

Expected: FAIL.

- [ ] **Step 3: Implement the team overlay**

Match `GroupCallView.tsx`:

- Button hidden for `room.dm == true`.
- Start requires every visible member to have a voice (`requireEveryMemberVoice`).
- Capture finals run through `GroupCallRouting.route`. Mentions-mode + `addressed == false` → do not send; show “Say a member's name — {names} — or say everyone.”
- Enqueue `tool.spoken` and member replies with that member's `voice` / avatar. `sayGeneration` / `queueGeneration` tokens drop stale work.
- `busyBotId` keeps phase `working` until the queue drains, then listen after ~140ms (desktop `scheduleListen`). After a user send while the room is still busy, wait ~600ms before listening so the first chip can arrive.
- Tap Interrupt: drop queue, `CallSpeaker.stop()`, if `busyBotId != nil` then `Client.interrupt(roomId:)`, then listen. This is still tap barge-in, not voice barge-in.
- Caption shows which member is speaking.
- Same hang-up rules as 1:1. Only one `Session.currentCallId` globally.

Skip reconstructed/unsupported rooms: if the Hub has no `/api/groups/:id/messages` semantics for that room (already true for reconstructed groups), `CallAvailability.canStart` is false with “Team calls need a V Bot room.”

- [ ] **Step 4: Run Swift tests and simulator build**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add half-duplex team calls`

---

### Task 9: Roleplay, Local Models, and Capability Honesty

**Files:**
- Modify: `ios/Sources/CompanionCore/CallModePolicy.swift`
- Modify: `ios/App/CallView.swift`, `ios/App/GroupCallView.swift`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: existing bot model selection, persona/instructions, engine capability flags, bridge roster.
- Produces: call path that does not special-case engines; unsupported capabilities stay hidden.

- [ ] **Step 1: Write failing honesty tests**

```swift
func testRoleplayAndLocalModelsUseTheNormalSendPath() {
    XCTAssertEqual(CallModePolicy.sendPath(isRoom: false), .botMessage)
    XCTAssertEqual(CallModePolicy.sendPath(isRoom: true), .groupMessage)
}

func testCallDoesNotRequireABridgeTtsCapability() {
    XCTAssertEqual(CallModePolicy.requiredBridgeCapabilities, [])
}

func testUnsupportedGroupEnginesCannotStartATeamCall() {
    XCTAssertFalse(CallModePolicy.allowsRoomCall(engineSupportsGroups: false, isDm: false))
}
```

- [ ] **Step 2: Run the tests**

Expected: FAIL until those predicates exist.

- [ ] **Step 3: Keep the brain on the Hub**

No speech-to-speech provider. A roleplay bot already has its persona on the Hub; the phone sends transcribed text and speaks `speech-text.ts` output. A local model (LM Studio, injected Codex/Claude local slugs, Hermes local) is just a slower `working` phase — narration of `tool.spoken` is what keeps the call from sounding dead. If a local model emits no chips, keep the Working spinner; do not fake progress.

Bridge placement for this MVP:

| Function | Where |
| --- | --- |
| STT | iPhone, on-device Speech |
| Turn-taking | iPhone `CallModePolicy` |
| Chat, tools, approvals, SSE | Hub via companion |
| TTS (ElevenLabs or macOS `say`) | Hub `server/tts` |
| Shell / Local VM / SSH | Existing bridges only |

Do not synthesize on a bridge. Do not move the ElevenLabs key. If the Hub is Linux and only `system` voices exist, `voiceReady` is false until ElevenLabs or later Kokoro is configured — same as desktop.

- [ ] **Step 4: Re-run policy tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): keep voice calls engine-agnostic`

---

### Task 10: Flags, Privacy Strings, Tests, and Device Gates

**Files:**
- Modify: `ios/project.yml` (`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`)
- Modify: `ios/TESTING.md`
- Modify: `docs/voice-mode.md`
- Modify: `docs/ios-companion.md`
- Modify: `ios/AppStore/en-US/release_notes.txt` only if a future build note is being drafted; do not bump build number

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: honest docs and a runbook. No TestFlight upload.

- [ ] **Step 1: Update purpose strings**

Microphone: `V Bot listens while you dictate a message or talk to a bot on a call.`
Speech: `V Bot converts your speech into text on this iPhone so you can message or call a bot.`

- [ ] **Step 2: Add the device exit criteria to `ios/TESTING.md`**

Physical iPhone, flag on, paired Hub with a ready voice:

1. Composer dictation still press-to-stop, including after hanging up a call.
2. 1:1: speak one turn, hear tool narration and the reply.
3. Tap Interrupt mid-sentence; mic reopens; bot does not transcribe its own voice.
4. Approval: spoken yes/no only; a rambling “sure, and also …” re-asks.
5. Team: name a member, hear that member, then a second member only after the first finishes.
6. Mentions-mode room refuses unaddressed speech with a name hint.
7. Background, lock, or leave chat releases the mic and ends the call.
8. LAN companion and hosted HTTPS companion both work.
9. Revoked pairing ends the call and cannot restart it.
10. Flag off: no call button.

Simulator cannot prove AEC, silence endpointing quality, or speakerphone echo. Record those as device gates, not as green CI.

- [ ] **Step 3: Update `docs/voice-mode.md`**

Replace “Calls are macOS-only” and “Rooms don't speak yet” with: desktop remains the reference implementation; iOS is foreground half-duplex behind `features.iosVoiceCalls`. Keep the AEC paragraph. State Kokoro is the next Hub provider, not a renderer bundle.

- [ ] **Step 4: Run the automated gate**

`pnpm exec vitest run companion/test/routes.test.ts src/lib/feature-flags.test.ts server/config.test.ts src/lib/group-call.test.ts src/lib/call.test.ts`
`swift test --package-path ios`
XcodeGen + unsigned iOS Debug simulator build.

Expected: all pass. Do not claim device quality from simulator.

- [ ] **Step 5: Commit**

Commit message: `docs(ios): document native voice-call gates`

---

### Task 11: Next — Kokoro on the Hub (not this MVP)

Do this only after Tasks 1–10 are merged and the device exit criteria pass. It is a Hub TTS provider, not a phone feature.

**Files (later):**
- Modify: `server/tts/index.ts` (`VoiceProvider` currently `"elevenlabs" | "system"`)
- Create: `server/tts/kokoro.ts` (OpenAI-compatible `POST /v1/audio/speech`)
- Modify: `server/tts/tts.test.ts`, `server/config.ts` (no new npm package; use existing `fetch`)
- Modify: `docs/voice-mode.md`

**Interfaces:**
- Consumes: existing `toUtterances` / `/api/tts/prepare` / `/api/tts/speak`.
- Produces: `VoiceProvider = "elevenlabs" | "system" | "kokoro"`. Phone code unchanged: it still plays opaque bytes.

- [ ] **Step 1: Failing provider tests**

Prove `voiceProvider` accepts `kokoro`, `listVoices` hits the local OpenAI-compatible catalog, `speak` POSTs `{ model, input, voice }` and returns WAV/MP3 bytes, and a missing base URL throws `NoVoiceConfigured("key")` without touching ElevenLabs.

- [ ] **Step 2: Implement behind `server/tts/index.ts`**

Config lives next to the existing TTS key: Hub-only, never on the companion config payload. Do not download models in the iOS app. Do not add ONNX. Streaming TTS is a follow-up after clip-based Kokoro works.

- [ ] **Step 3: Placement if the Hub is not the GPU box**

Still no bridge capability in that follow-up until Kokoro-on-Hub is proven. If a later plan adds `BridgeCapability "tts"`, it must be advertised, granted, and approval-gated like `shell`. That is not this task.

- [ ] **Step 4: Commit only in the later PR**

Commit message: `feat(tts): add Hub Kokoro provider`

---

### Task 12: Explicit Full-Duplex Deferral

**Files:**
- Modify: `docs/voice-mode.md` (Known gaps)
- Keep: `CallModePolicy.allowsOpenMicDuringPlayback == false`

**Interfaces:**
- Consumes: current capture path (`SFSpeechRecognizer` + raw `AVAudioEngine` tap, no AEC).
- Produces: written rejection of “just leave the mic open.”

Do not implement full duplex in this plan. Voice barge-in during playback will echo the bot into the next user turn. A future AEC plan must show, on a physical iPhone speakerphone and receiver, that the recognizer does not transcribe TTS playback before `allowsOpenMicDuringPlayback` can flip.

Tap interrupt remains the barge-in mechanism.

- [ ] **Step 1: Keep the failing-closed test from Task 2 in CI**

If someone deletes `allowsOpenMicDuringPlayback` or starts capture from `.speaking`, CI fails.

- [ ] **Step 2: Document the AEC gate in `docs/voice-mode.md`**

One paragraph: proven AEC (Voice Processing IO / `AVAudioEngine` voice-processing tap or equivalent) on iPhone and Mac, plus a device test that plays TTS into the mic and expects no user turn. Until then, half-duplex.

- [ ] **Step 3: No code beyond the policy flag and docs**

- [ ] **Step 4: Commit with Task 10 if the docs land together; otherwise**

Commit message: `docs(voice): defer full duplex until proven AEC`

---

## Device Exit Criteria (MVP done)

All of these on a physical iPhone with `features.iosVoiceCalls: true`, a paired Hub, and a ready voice. Simulator is not sufficient.

- Speak one 1:1 turn; hear `tool.spoken` narration and the settled reply.
- Tap Interrupt mid-speech; capture resumes; the bot's voice is not sent as a user message.
- Automatic silence (~850ms) sends without a second tap.
- Team call sequences two members; the second waits.
- Approval yes/no safety holds; rambling speech re-asks.
- Roleplay bot and a local-model bot both work through ordinary send/SSE.
- Background / lock / interruption / leave chat / revoked pairing release the mic.
- Composer dictation still works afterward.
- LAN and hosted HTTPS both work.
- Flag off hides the call button.
- Full duplex is not present.

## Out of Scope

- CallKit, incoming PSTN, Bluetooth headset UX polish beyond the system route, PTT (desktop Control+Option is not ported; iPhone uses silence endpointing).
- Auto-speak of replies outside an active call.
- Spend meter for ElevenLabs.
- Streaming TTS, websocket voice, S2S models.
- Bridge-hosted TTS.
- Background calls.
- Opening the mic during playback.

---

## Self-Review

### Spec coverage

| Requirement | Task |
| --- | --- |
| First-party V Bot iPhone call UI | 6, 8 |
| Foreground only | 2, 6, 10 |
| Half-duplex 1:1 | 2, 5, 6 |
| Team / group calls | 3, 8 |
| Apple on-device STT | 5 |
| Reuse chat / SSE / TTS | 1, 4, 6 |
| Tap interrupt | 2, 6, 8 |
| Automatic silence 850ms | 5 |
| Group turn sequencing | 8 |
| Spoken approvals | 3, 7 |
| Roleplay / local models | 9 |
| Kokoro next (Hub, not phone) | 11 |
| Capability negotiation / bridge placement | 2, 9, 11 |
| Tests / flags | 1, 2, 10 |
| Defer full duplex until proven AEC | 2, 12 |
| No new dependencies / no extra files in this planning commit | this document only |

### Placeholder scan

No TBD/TODO/implement-later steps. Kokoro and full duplex are named follow-up tasks with explicit non-implementation in MVP.

### Type consistency

`CallPhase`, `CallAvailability`, `SpokenGroupMessage`, `PreparedSpeech`, `CALL_ENDPOINT_MS = 850`, YES/NO regexes, and HTTP paths are named once in Interfaces and reused.

### Supersession

Parity closeout Task 5 (“no room calls”) is superseded by Tasks 3 and 8 of this plan.
