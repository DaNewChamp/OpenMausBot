# V Bot Native iPhone Voice Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-party V Bot foreground iPhone half-duplex voice MVP for 1:1 bots and team rooms by reusing Apple on-device speech recognition, the existing paired chat/SSE/TTS path, tap interrupt, 850ms silence endpointing, group turn sequencing, and spoken yes/no approvals.

**Architecture:** The phone is only the microphone, speaker, and call surface. Capture uses in-process `SFSpeechRecognizer` on `AVAudioEngine` with the mic closed during playback because this recognizer has no acoustic echo cancellation. Final user turns go through existing `Session.send(_:to:mode:)` so `VBotMutationRouting` keeps native OpenMaus vs reconstructed routing; overlays must not call `CompanionClient.send`. Approvals use `Session.answer`; interrupt uses `Session.interrupt`. Reconstructed chats are reference-only and not a call MVP target. The Hub folds replies, `tool.spoken` narration, and approval cards over the existing SSE stream; `/api/tts/prepare` plus `/api/tts/speak` stay on the Hub so credentials never reach the phone. Team calls queue one member at a time and route spoken names onto the room's existing `@mention` syntax. Full duplex stays deferred until a proven AEC capture path exists. Kokoro is the next Hub TTS provider, not part of this MVP.

**Tech Stack:** Swift 6 / SwiftUI / Speech / AVFoundation, CompanionCore (Foundation-only policies + HTTP), existing Node companion allowlist, Hub `server/tts/*` and `/api/events`, zero new dependencies.

## Global Constraints

- Clean-room original V Bot UI and copy only; do not copy proprietary Grok Bot code, routes, or assets.
- No new npm, Swift, or system dependencies. No ONNX, no phone-side Kokoro, no ElevenLabs Agents, no OpenAI Realtime, no Gemini Live.
- Do not add, remove, or upgrade packages in this plan.
- Half-duplex only: the microphone is live only when the bot is not speaking, except while a spoken approval/question is waiting for a yes/no or an answer.
- Do not leave the mic open during TTS playback. Full-duplex barge-in is out of scope until a proven AEC capture path exists and is tested on device.
- Foreground iPhone only. No CallKit, no background VoIP, no lock-screen continuation. Background, lock, audio interruption, revoked pairing, or leaving the chat hangs up and releases the mic.
- Apple on-device recognition when `supportsOnDeviceRecognition` is true; never send call audio to a cloud STT. Composer dictation stays press-to-stop with no silence timeout.
- Reuse current chat, SSE, group send, interrupt, approval respond, and TTS prepare/speak. Call overlays submit finals through `Session.send(_:to:mode:)` (which applies `VBotMutationRouting`), not `CompanionClient.send`. Do not invent a voice websocket or a second transcript store.
- Reconstructed engine chats are reference-only in this MVP: hide the call button when `CallModePolicy.allowsNativeCall(mutationTarget:)` is false. Do not treat reconstructed rooms as sendable call targets.
- Native room/group-call support is the server `VBotEngineCapabilities.groups` boolean on `GET /api/vbot/engine-sync`, decoded fail-closed on iOS, then AND-ed with advertised Hermes `capabilities.hermesBot.capabilities.groups` only when a visible member’s instance advertises `hermesBot`. Do not infer groups from roster shape and do not hardcode engine or instance ids.
- Companion `/api/tts/prepare` availability is sidecar `ttsPrepareVersion` on `GET /api/companion/endpoints`. Hub `features.iosVoiceCalls` does not imply the sidecar allowlists or implements prepare. Missing/unknown versions fail closed.
- `requireEveryMemberVoice` and `allowsRoomCall` both require at least one visible (`hidden != true`) room member. An empty member list is not vacuously ready.
- TTS credentials stay on the Hub. The phone receives voice labels and audio bytes only.
- Bridges keep their current advertised capabilities (`shell`, `local-vm`, `ssh-forward`). Do not add a `tts` bridge capability in this MVP.
- Roleplay personas and local-model bots use the same send/SSE path as every other bot. Do not add a voice-only system prompt or a special engine.
- `com.posival.openmausmobile`, existing pairing, and composer dictation must keep working after hang-up.
- Feature-flag the iOS call button until the device exit criteria pass. Desktop calls stay unchanged.
- Privileged spoken approvals on iOS are strict whole-utterance yes/no after trimming punctuation and whitespace. Do not copy the desktop prefix `\b` regex onto the phone. Desktop matcher hardening is a follow-up, not this MVP.
- Do not deploy, change networking, or upload TestFlight without Vincent's explicit approval.

---

## Seams Inspected (do not re-audit)

Read-only pass on 2026-09-01. Implementers should treat these as the source of truth and extend them rather than inventing a parallel stack.

| Seam | Where it lives today | Call MVP implication |
| --- | --- | --- |
| Desktop 1:1 call | `src/components/CallView.tsx`, `src/lib/call.ts` | Phase loop is `listening → sending → working → speaking`. Mic closed during playback. Tap / Space interrupts. Escape hangs up. `CALL_ENDPOINT_MS = 850`. |
| Desktop team call | `src/components/GroupCallView.tsx`, `src/lib/group-call.ts` | One mic, queued member speech, `routeSpokenGroupMessage`, `busyBotId` gates listen, interrupt also POSTs group interrupt. DMs have no call button. Rooms require every member to have a voice. |
| Desktop STT | `electron/resources/speech-helper.swift` | Buffer-backed `SFSpeechRecognizer` does not finalize on silence; helper `--endpoint-ms` calls `endAudio()`. Intentional stops must not emit a final transcript. |
| Desktop TTS | `src/lib/tts/index.ts`, `server/tts/index.ts`, `server/index.ts` `/api/tts/prepare` + `/api/tts/speak` | Prepare splits utterances on the Hub. Speak returns opaque audio bytes. Prefetch utterance n+1 while n plays. Abortable. Speak cap is Hub `text.length > 500` (JS UTF-16 code units, 413). Desktop `JSON.stringify({ text, voiceId })` omits `voiceId` when undefined for both prepare and speak. |
| iOS STT | `ios/App/SpeechDictation.swift`, `ios/Sources/CompanionCore/Dictation.swift` | Composer only. Category `.record`. No silence endpointing. On-device when supported. `ChatView` already stops dictation on background, leave, and audio interruption. |
| iOS TTS | `CompanionClient.previewVoice` → `POST /api/tts/speak`; `AgentProfileView` plays with `AVAudioPlayer` | Preview exists and silently `prefix(500)` (Swift graphemes; leave it). Prepare is missing on the iOS client. Companion allowlist has voices + speak, **not** prepare. Call synthesis must reject oversize text using Hub UTF-16 `text.length`, not `String.count`, and must not truncate. |
| Chat / SSE | `Session.send` (`VBotMutationRouting` → OpenMaus `CompanionClient.send` or reconstructed `sendReconstructed`); `Session.interrupt`; `Session.answer`; `ios/Sources/CompanionCore/SSE.swift` | Call finals use `Session.send`, never overlay→`CompanionClient.send`. Reconstructed is reference-only (no call button). `Message.tool.spoken` is already decoded. |
| Group routing | `ios/Sources/CompanionCore/GroupRouting.swift`, `src/lib/group-routing.ts` | Composer `@mentions`. Spoken “Atlas, …” must be rewritten before send (`src/lib/group-call.ts` already does this on desktop). |
| Approvals | `CompanionClient.respond(threadId:requestId:behavior:message:)`, desktop YES/NO **prefix** regex in `CallView.tsx` / `GroupCallView.tsx` | Speak the card. iOS grants or denies only on a strict whole-utterance yes/no after trim. Ambiguous speech re-asks. Non-permission questions take the next complete turn as the answer. Do not port the desktop `\b` regex. |
| Capability / bridges | `server/bridge-registry.ts` `BridgeCapability = "shell" \| "local-vm" \| "ssh-forward"` | TTS is Hub-owned. Phones talk only to the companion. Do not place STT or TTS on a bridge in this MVP. |
| Engine group capability | `server/vbot-engine-sync.ts` `VBotEngineCapabilities`; iOS `VBotEngineSync` currently does **not** decode `engineCapabilities` | Add `groups: boolean` on the Hub payload. iOS must decode it with `decodeIfPresent` / `== true` fail-closed. Do not infer from `VBotSyncedGroup` roster rows. |
| Hermes groups | `server/engines/contracts.ts` `HermesCapabilityFlags.groups` (false today); `server/index.ts` `describeProviderInstances()` copies that object onto `GET /api/instances` `capabilities.hermesBot` when Hermes is enabled | iOS `InstanceCapabilities` must decode `hermesBot.capabilities.groups` fail-closed. Room calls AND that flag only when a visible member’s instance advertises `hermesBot`. Do not switch on `"hermes"` / instance id. |
| Sidecar prepare handshake | `companion/src/proxy.ts` `GET /api/companion/endpoints` (`CompanionEndpointSnapshot`: `serverName` + `endpoints` only today) | Advertise `ttsPrepareVersion: 1` here (sidecar-owned, not Hub config). Old snapshots without the field keep decoding for routes and fail closed for calls. |
| Flags | `src/lib/feature-flags.ts` | Experimental features are explicit opt-in (`skillRecorder`). iOS calls follow that pattern. Existing `features.browser` stays as-is. Hub `iosVoiceCalls` is not a sidecar prepare advertisement. |
| Voice decision doc | `docs/voice-mode.md` | Half-duplex rationale, 850ms endpointing, narration, spoken approvals, rejected realtime/S2S providers, Kokoro previously rejected as a **renderer** bundle. This plan places Kokoro later **on the Hub**, not on the phone. |
| Supersedes | `docs/superpowers/plans/2026-08-31-vbot-ios-parity-closeout.md` Task 5 | That task said “no room calls”. This plan requires team calls in the same MVP. |

Immediate backend blocker: `companion/src/routes.ts` allowlist includes `GET /api/tts/voices` and `POST /api/tts/speak` only. Desktop `Speaker.prepare` already POSTs `/api/tts/prepare`. The phone cannot split markdown into speakable utterances until that route is allowlisted **and** the sidecar advertises `ttsPrepareVersion: 1` on `GET /api/companion/endpoints`. An updated Hub flag with an old sidecar must not start a call.

---

## File Map

Create:

- `ios/Sources/CompanionCore/CallModePolicy.swift` — phase machine, availability, hang-up rules, approval speech, duplex guard, speech queue, ownership helpers.
- `ios/Sources/CompanionCore/GroupCallRouting.swift` — Swift port of `routeSpokenGroupMessage`.
- `ios/Sources/CompanionCore/CallSpeaker.swift` — Hub prepare/synthesize client orchestration (HTTP only, no AVFoundation) plus `CallAudioPlaying`.
- `ios/App/CallCapture.swift` — call-mode `SFSpeechRecognizer` with 850ms silence endpointing.
- `ios/App/CallAudioPlayer.swift` — App-target `NSObject` + `AVAudioPlayerDelegate` + `CallAudioPlaying` conformer.
- `ios/App/CallView.swift` — 1:1 overlay. Wires CompanionCore helpers; does not own approval parsing.
- `ios/App/GroupCallView.swift` — team overlay. Created in Task 8; consumes Task 3/7 CompanionCore helpers. Task 7 must not edit this file.
- `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`
- `ios/Tests/CompanionCoreTests/GroupCallRoutingTests.swift`
- `ios/Tests/CompanionCoreTests/VoiceClientTests.swift`

Modify:

- `companion/src/routes.ts` and `companion/test/routes.test.ts` — allow `POST /api/tts/prepare`.
- `companion/src/proxy.ts` `CompanionEndpointSnapshot` / `endpointSnapshot()` and `companion/test/proxy.test.ts` — emit `ttsPrepareVersion: 1` on `GET /api/companion/endpoints`.
- `server/config.ts`, `server/index.ts` `configStatus()`, `src/lib/feature-flags.ts` — `iosVoiceCalls` opt-in, emitted on `GET /api/config` (already phone-readable; PATCH remains desktop-only).
- `server/config.test.ts`, `src/lib/feature-flags.test.ts`
- `server/vbot-engine-sync.ts` and `server/vbot-engine-sync.test.ts` — add `VBotEngineCapabilities.groups`; OpenMaus `true`, reconstructed `false` (do not infer from roster groups).
- `ios/Sources/CompanionCore/Client.swift` — `prepareSpeech` and `synthesizeSpeech` next to `previewVoice`.
- `ios/Sources/CompanionCore/Models.swift` — decode optional `ConfigStatus.features.iosVoiceCalls`; decode `VBotEngineSync.engineCapabilities` fail-closed; decode `CompanionConnectionMetadata.ttsPrepareVersion`; decode `InstanceCapabilities.hermesBot.capabilities.groups`.
- `ios/Tests/CompanionCoreTests/EngineSyncTests.swift`, `ios/Tests/CompanionCoreTests/EndpointRefreshTests.swift`
- `ios/App/SpeechDictation.swift` is **not** modified. `CallCapture` calls `Dictation.localeCandidates()` directly.
- `ios/App/ChatView.swift`, `ios/App/ChatChromeView.swift`, `ios/App/Session.swift` — call button, overlay, hang-up on leave/background/pairing loss. Call overlays use existing `Session.send` / `interrupt` / `answer` (optional deny `message`); do not add a parallel send API. `Session` keeps in-memory `ttsPrepareVersion: Int?` from `GET /api/companion/endpoints` (cleared on disconnect; not persisted on `Connection`).
- `ios/project.yml` — purpose strings mention calls.
- `docs/voice-mode.md`, `docs/ios-companion.md`, `ios/TESTING.md` — current-state + device gates.
- `server/tts/index.ts` is **not** modified in MVP. Kokoro is Task 11 (next), after the phone loop works.

Do not create: CallKit providers, websocket voice routes, bridge `tts` capability, renderer Kokoro, or a second SSE stream.

---

## Interfaces (locked names)

These signatures are the contract. Later tasks must call them exactly; do not invent parallel names.

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
    public init(id: String, threadId: String, isRoom: Bool, name: String, voices: [String?])
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
    public init(text: String, addressed: Bool)
}

public struct PreparedSpeech: Equatable, Sendable {
    public var ready: Bool
    public var utterances: [String]
    public init(ready: Bool, utterances: [String])
}

public enum CallSendPath: Equatable, Sendable {
    case botMessage
    case groupMessage
}

public struct QueuedSpeech: Equatable, Sendable {
    public var text: String
    /// Nil when `tool.spoken` / a reply has no matching room member. Never invent a member id.
    public var botId: String?
    public var voiceId: String?
    public var messageId: String?
    /// Caption. Missing sender uses `CallModePolicy.unnamedSpeakerLabel`, not a fake name.
    public var speakerLabel: String
    public init(
        text: String,
        botId: String?,
        voiceId: String? = nil,
        messageId: String? = nil,
        speakerLabel: String
    )
}

/// App-target playback. CompanionCore never imports AVFoundation.
public protocol CallAudioPlaying: AnyObject {
    /// Play opaque Hub TTS bytes. Resolves `true` when the clip finished
    /// to the end, `false` when `cancel()` ran or decode/play failed.
    func play(_ data: Data) async -> Bool
    /// Stop current playback immediately. Any in-flight `play` must resolve `false`.
    func cancel()
}

public enum CallModePolicy {
    public static let endpointMs: Int = 850
    public static let composerEndpointMs: Int = 0
    public static let allowsOpenMicDuringPlayback: Bool = false
    public static let requiredBridgeCapabilities: [String] = []
    public static let reaskPrompt = "Sorry — is that a yes or a no?"

    public static func availability(
        flagged: Bool,
        speechAvailable: Bool,
        ttsConfigured: Bool,
        agentVoice: String?,
        workspaceDefaultVoice: Bool,
        requireEveryMemberVoice: Bool,
        memberVoices: [String?],
        companionPrepareAllowed: Bool,
        foreground: Bool,
        paired: Bool
    ) -> CallAvailability

    /// Single reducer used by every test and both overlays.
    /// `availability` is always passed (never omitted). Full transition table is
    /// under "Reducer contract" below this interfaces block. Fail-closed:
    /// never open the mic during playback (`.speaking`); stray `captureFinal`
    /// outside `.listening` does not send; `botBusy(false)` does not leave
    /// `.speaking`.
    public static func reduce(
        phase: CallPhase,
        availability: CallAvailability,
        awaitingSpokenDecision: Bool,
        event: CallEvent
    ) -> CallPhase

    public static func micOpen(phase: CallPhase, awaitingSpokenDecision: Bool) -> Bool

    /// Privileged consent. Never copy the desktop `/^(yes|...)\b/i` prefix regex.
    /// 1. Trim whitespace/newlines.
    /// 2. Lowercase.
    /// 3. Trim leading and trailing `CharacterSet.punctuationCharacters` (ends only, so `don't` stays intact).
    /// 4. Exact-match the whole remaining string against the yes or no phrase lists below.
    /// Prefix hits such as `yes please delete everything` are `.reask`.
    public static func approvalDecision(from raw: String) -> ApprovalSpeechDecision

    public static func shouldSend(finalText: String, intentionalStop: Bool) -> Bool
    public static func shouldTreatSpeechAsApproval(askedRequestId: String?, currentRequestId: String?) -> Bool

    /// Returns `to`. Caller assigns `Session.currentCallId` after stopping the previous call's capture/speaker.
    public static func transfer(current: String?, to targetId: String) -> String
    /// True iff `current == targetId` and `current != nil`. Stale teardowns for a previous target return false and must not mutate Session.
    public static func end(current: String?, targetId: String) -> Bool

    public static func requiresAddress(defaultResponderKind: String) -> Bool
    /// True iff `!isDm && engineSupportsGroups && visibleMemberCount > 0`.
    public static func allowsRoomCall(
        isDm: Bool,
        engineSupportsGroups: Bool,
        visibleMemberCount: Int
    ) -> Bool
    /// Authoritative native room/group-call AND. `== true` only; nil/false fail closed.
    /// `visibleMemberAdvertisesHermes` is `instance.capabilities.hermesBot != nil`
    /// for a visible member, never an instanceId/engine-id string compare.
    public static func nativeRoomCallSupported(
        engineGroups: Bool?,
        hermesGroups: Bool?,
        visibleMemberAdvertisesHermes: Bool
    ) -> Bool
    /// True iff `ttsPrepareVersion == requiredTtsPrepareVersion`. Nil/other fail closed.
    public static func companionPrepareAllowed(ttsPrepareVersion: Int?) -> Bool
    public static func sendPath(isRoom: Bool) -> CallSendPath
    /// True iff `mutationTarget == .openmaus`. Reconstructed is reference-only, not a call target.
    public static func allowsNativeCall(mutationTarget: VBotPrimaryEngine) -> Bool

    public static let requiredTtsPrepareVersion = 1
    public static let reasonReconnect = "Reconnect this phone to start a call."
    public static let reasonForeground = "Return to the chat to start a call."
    public static let reasonFlagOff = "Turn on iOS voice calls in desktop Settings."
    public static let reasonCompanionPrepare = "Update the companion on this computer to start a call."
    public static let reasonSpeechUnavailable = "On-device speech recognition is unavailable."
    public static let reasonTtsUnconfigured = "Set up a voice so the bot can speak."
    public static let reasonEmptyRoom = "Add a room member before starting a team call."
    public static let reasonEveryMemberVoice = "Give every room member a voice."
    public static let reasonChooseVoice = "Choose a voice before starting a call."
    public static let reasonUnsupportedRoomEngine = "Team calls need a V Bot room."

    /// Desktop GroupCallView caption when `speakingMember` is missing: "Channel member".
    public static let unnamedSpeakerLabel = "Channel member"

    public static func permissionPrompt(name: String, tool: String, detail: String) -> String
    public static func questionPrompt(name: String, detail: String, options: [String]) -> String
    public static func denyMessage(isRoom: Bool) -> String

    public struct SpeechQueue: Equatable, Sendable {
        public init()
        /// `botId`/`voiceId` nil = missing sender. Default label is `unnamedSpeakerLabel`.
        /// Overlay must not invent a `Member` to satisfy this call.
        public mutating func enqueue(
            _ text: String,
            botId: String?,
            voiceId: String? = nil,
            messageId: String? = nil,
            speakerLabel: String = CallModePolicy.unnamedSpeakerLabel
        )
        public mutating func next() -> QueuedSpeech?
        /// Drops remaining items. Does not speak.
        public mutating func interrupt()
    }
}

public enum GroupCallRouting {
    public struct Member: Equatable, Sendable {
        public var id: String
        public var name: String
        public init(id: String, name: String)
    }
    public static func route(text: String, members: [Member]) -> SpokenGroupMessage
}

extension CompanionClient {
    /// POST `/api/tts/prepare` body `{ text, voiceId? }` → `{ ready, utterances }`.
    /// `voiceId` omission: if `voiceId` is nil or empty after trim, omit the JSON key
    /// (do not send `null`). Same rule as `synthesizeSpeech` and desktop
    /// `JSON.stringify({ text, voiceId })` which drops `undefined`.
    /// If `ready == false`, throw `APIError.status(code: 409, message:)` with desktop Speaker.prepare copy:
    /// "Add the shared ElevenLabs key in an agent profile on this computer, then pick a voice for the agent."
    public func prepareSpeech(text: String, voiceId: String?) async throws -> PreparedSpeech

    /// POST `/api/tts/speak` body `{ text, voiceId? }` → opaque audio bytes.
    /// Calls `CallSpeaker.assertSpeakable` first. Does not silently `prefix(500)`.
    /// Omit `voiceId` with the same nil/empty rule as `prepareSpeech`.
    /// `previewVoice(text:voiceId:)` stays for the profile sheet and keeps its existing truncation.
    public func synthesizeSpeech(text: String, voiceId: String?) async throws -> Data
}

public final class CallSpeaker: @unchecked Sendable {
    /// Hub `POST /api/tts/speak` rejects `text.length > 500` (JavaScript UTF-16 code units).
    /// Do not use Swift `String.count` (extended grapheme clusters).
    public static let maxSpeakUTF16CodeUnits = 500
    public enum SpeakError: Error, Equatable, Sendable {
        case tooLong(Int)
    }

    /// Throws `SpeakError.tooLong(text.utf16.count)` when `text.utf16.count > maxSpeakUTF16CodeUnits`.
    /// Empty text is allowed here; `synthesizeSpeech` still needs Hub-nonempty text.
    public static func assertSpeakable(_ text: String) throws

    public private(set) var error: String?

    public init(
        prepare: @escaping (String, String?) async throws -> PreparedSpeech,
        synthesize: @escaping (String, String?) async throws -> Data,
        player: any CallAudioPlaying
    )
    public convenience init(client: CompanionClient, player: any CallAudioPlaying)

    /// Prepare once, synthesize utterance 0, prefetch n+1 while n plays, like `src/lib/tts/index.ts`.
    /// Never throws: failures set `error` and return. `stop()` bumps a generation token, cancels
    /// in-flight work, and calls `player.cancel()` so utterance n+1 never plays.
    public func speak(text: String, voiceId: String?, botId: String?, messageId: String?) async
    public func stop()
}

/// App target only. `AVAudioPlayer` requires `NSObject` + `AVAudioPlayerDelegate`
/// for `audioPlayerDidFinishPlaying(_:successfully:)`.
final class CallAudioPlayer: NSObject, AVAudioPlayerDelegate, CallAudioPlaying {
    func play(_ data: Data) async -> Bool
    func cancel()
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool)
}

/// App target only.
final class CallCapture {
    var onPartial: ((String) -> Void)?
    var onFinal: ((String) -> Void)?
    func start()
    func stop(intentional: Bool)
}

// Existing App-target Session API. Call overlays must use these so
// VBotMutationRouting stays intact. Do not call CompanionClient.send
// / interrupt / respond from CallView or GroupCallView.
extension Session {
    @discardableResult
    func send(_ text: String, to chat: Chat, mode: MessageDeliveryMode = .auto) async -> MessageDeliveryReceipt?
    func interrupt(chat: Chat) async
    /// Optional `message` is passed to `respond` for allow/deny (call deny copy).
    /// Existing composer / Live Activity callers omit it.
    func answer(threadId: String, requestId: String, choice: String, isPermission: Bool, message: String? = nil) async
}
```

Yes phrases (whole utterance after the trim above): `yes`, `yeah`, `yep`, `yup`, `sure`, `ok`, `okay`, `go ahead`, `do it`, `allow`, `approve`, `approved`, `fine`, `please do`.

No phrases (whole utterance after the trim above): `no`, `nope`, `don't`, `dont`, `do not`, `stop`, `deny`, `denied`, `cancel`, `never`, `skip it`.

Do **not** implement those lists as the desktop regexes:

```
/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i
/^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i
```

Those `\b` prefix matchers live in `src/components/CallView.tsx` and `src/components/GroupCallView.tsx`. Leave them unchanged in this MVP. A later desktop-only follow-up should switch them to the same whole-utterance parser so “yes please delete everything” cannot grant. That follow-up is out of scope here.

`CallModePolicy.availability` voiceReady and reason:

Visible room members are bots in `room.memberIds` whose `hidden != true` (same filter as `GroupRouting.visible`). Overlay passes those members’ `voice` values as `memberVoices` and `visibleMemberCount`.

- When `requireEveryMemberVoice == false`: `voiceReady` is true if `agentVoice` is non-empty or `workspaceDefaultVoice == true` (desktop 1:1 / `ConfigStatus.canSpeak`).
- When `requireEveryMemberVoice == true`: `voiceReady` is true only if `memberVoices` is **nonempty** and every entry is non-nil and non-empty after trim. Workspace fallback is not enough. `memberVoices: []` is not ready.

`reason` is one of the locked `reason*` constants, or `""` when `canStart` is true. First failing gate wins, in this order:

1. `paired == false` → `reasonReconnect`
2. `foreground == false` → `reasonForeground`
3. `flagged == false` → `reasonFlagOff`
4. `companionPrepareAllowed == false` → `reasonCompanionPrepare`
5. `speechAvailable == false` → `reasonSpeechUnavailable`
6. `ttsConfigured == false` → `reasonTtsUnconfigured`
7. `voiceReady == false` and `requireEveryMemberVoice` and `memberVoices.isEmpty` → `reasonEmptyRoom`
8. `voiceReady == false` and `requireEveryMemberVoice` → `reasonEveryMemberVoice`
9. `voiceReady == false` → `reasonChooseVoice`
10. else → `""`

Do not concatenate, localize, or paraphrase these strings in overlays. Tests compare `==`, not `contains`.

`companionPrepareAllowed(ttsPrepareVersion:)` is true iff `ttsPrepareVersion == requiredTtsPrepareVersion` (`1`). Hub `ConfigStatus.features.iosVoiceCalls` is `flagged` only. A true hub flag with a missing sidecar version must not start a call.

`requiresAddress` is true iff `defaultResponderKind == "mentions"`.

`nativeRoomCallSupported(engineGroups:hermesGroups:visibleMemberAdvertisesHermes:)` is true iff `engineGroups == true` and (`visibleMemberAdvertisesHermes == false` or `hermesGroups == true`). Nil bools are false. Overlay sets `visibleMemberAdvertisesHermes` when any visible member’s `GET /api/instances` row has `capabilities.hermesBot != nil`. Overlay sets `engineGroups` from `session.engineSync?.engineCapabilities.groups`. Overlay sets `hermesGroups` from that member’s `hermesBot.capabilities.groups`. Never branch on `VBotPrimaryEngine`, `"hermes"`, `"grokReconstructed"`, or instance id strings for this gate.

`allowsRoomCall(isDm:engineSupportsGroups:visibleMemberCount:)` is true iff `!isDm && engineSupportsGroups && visibleMemberCount > 0`. `engineSupportsGroups` is the boolean returned by `nativeRoomCallSupported`, not an inferred engine table. Chrome may show `reasonUnsupportedRoomEngine` when `allowsNativeCall` is true and `nativeRoomCallSupported` is false; that string is not a `CallAvailability.reason` gate. Empty rooms stay visible and use `reasonEmptyRoom`.

`sendPath(isRoom:)` is `.groupMessage` iff `isRoom`, else `.botMessage`.

`allowsNativeCall(mutationTarget:)` is true iff `mutationTarget == .openmaus`. `.grokReconstructed` is reference-only: no call button, no call overlay.

`unnamedSpeakerLabel` is `"Channel member"` (desktop GroupCallView when `speakingMember` is missing). Missing-sender `QueuedSpeech` uses this label, `botId == nil`, and `voiceId == nil` (Hub workspace default). Do not invent a member.

`shouldSend` is true iff `intentionalStop == false` and `finalText` is non-empty after trim.

`shouldTreatSpeechAsApproval` is true iff both request ids are non-nil and equal.

`micOpen` is true iff `phase == .listening` (including when `awaitingSpokenDecision == true`). False for `.speaking`, `.sending`, `.working`, `.ended`, `.idle`. Overlay must not start `CallCapture` unless `micOpen` is true.

`permissionPrompt` = `"{name} wants to {tool}. {detail}. Should I allow it?"`

`questionPrompt` = `"{name} asks: {detail}. The options are {options joined by commas}."`

`denyMessage(isRoom: false)` = `"Denied by the user, on a call."`

`denyMessage(isRoom: true)` = `"Denied by the user, on a group call."`

### Reducer contract

Apply in this order. Overlay drives `CallCapture` / `CallSpeaker` from the returned phase (`micOpen` iff `.listening`). Overlay must `CallSpeaker.stop()` and `CallCapture.stop(intentional: true)` before reducing `.tapInterrupt` so leftover playback cannot be captured.

**Guards (all events):**

1. If `phase == .ended` → `.ended` (including `.start`).
2. If `availability.foreground == false` or `availability.paired == false` → `.idle` stays `.idle`, every other phase → `.ended`.
3. `.hangUp`, `.backgrounded`, `.pairingRevoked` → `.idle` stays `.idle`, every other phase → `.ended`.

**Then, by event:**

| Event | From `.idle` | `.listening` | `.sending` | `.working` | `.speaking` |
| --- | --- | --- | --- | --- | --- |
| `.start` | `.listening` iff `canStart`, else `.idle` | stay | stay | stay | stay |
| `.capturePartial` | stay | stay | stay | stay | stay |
| `.captureFinal` empty/whitespace | stay | `.listening` | stay | stay | stay |
| `.captureFinal` non-empty | stay | `.sending` | stay | stay | stay |
| `.captureFailed` | stay | stay | stay | stay | stay |
| `.speakText` | stay | `.speaking` | `.speaking` | `.speaking` | `.speaking` |
| `.playbackFinished` | stay | stay | stay | stay | `.listening` if `awaitingSpokenDecision`, else `.working` |
| `.botBusy(true)` | stay | `.listening` if `awaitingSpokenDecision`, else `.working` | `.working` | `.listening` if `awaitingSpokenDecision`, else `.working` | `.speaking` |
| `.botBusy(false)` | stay | `.listening` | `.listening` | `.listening` | `.speaking` |
| `.tapInterrupt` | stay | `.listening` | `.listening` | `.listening` | `.listening` |

Fail-closed rules encoded above:

- No mic while playback: `.speakText` always enters `.speaking` from an active call; `.botBusy(false)` and stray `.captureFinal`/`.captureFailed` never leave `.speaking`.
- Stray `.captureFinal` outside `.listening` does not become a user turn (stay). Overlay must not call `Session.send` unless the reduced phase is `.sending`.
- `.captureFailed` never opens the mic and never sends. Overlay may later emit `.hangUp` for a fatal on-device/permission failure.
- `.playbackFinished` defaults to `.working` (mic closed). Overlay emits `.botBusy(false)` to listen when the bot is idle. After a spoken approval/question prompt, `awaitingSpokenDecision == true` so playback reopens listen.
- Overlay emission: dispatch `.captureFinal` only for a committed user turn (send) or a resolved allow/deny/answer. Reask swallows the transcript and dispatches `.speakText(reaskPrompt, ...)` without `.captureFinal`.

Hub/client HTTP (already exists except the allowlist + iOS prepare/synthesize wrappers):

- `POST /api/tts/prepare` body `{ text }` or `{ text, voiceId }` — omit `voiceId` when nil/empty, never `null`
- `POST /api/tts/speak` body `{ text }` or `{ text, voiceId }` — same omission; reject when `text.utf16.count > 500` before the wire; Hub backstop is `text.length > 500` (JS UTF-16 code units, 413)
- Call **user turns** are submitted only via `Session.send(_:to:mode:)` (OpenMaus `POST /api/bots/:id/messages` or `POST /api/groups/:id/messages`, or reconstructed `sendReconstructed` which this MVP never starts a call into). Overlays do not call `CompanionClient.send`.
- `POST /api/bots/:id/interrupt` and `POST /api/groups/:id/interrupt` via `Session.interrupt(chat:)`
- Approvals via `Session.answer` → `POST /api/threads/:id/respond` body `{ requestId, behavior, message? }`
- `GET /api/events` existing SSE
- `GET /api/vbot/engine-sync` — `engineCapabilities.groups` is the selected engine’s native room/group-call flag (OpenMaus `true`, reconstructed `false` until a reconstructed probe field exists). Do not treat `groups: []` vs nonempty roster as the capability.
- `GET /api/instances` — when Hermes is enabled, the Hermes instance already includes `capabilities.hermesBot.capabilities.groups` (false today). iOS must decode that nested object; omitted `hermesBot` means that instance does not advertise Hermes.
- `GET /api/companion/endpoints` — sidecar-owned snapshot `{ serverName, endpoints, ttsPrepareVersion: 1 }`. No paths, tokens, or Hub feature flags. Phone `companionPrepareAllowed` reads only `ttsPrepareVersion`.

Sidecar handshake (Task 1). Current `CompanionEndpointSnapshot` in `companion/src/proxy.ts` is `{ serverName, endpoints }`. Extend:

```ts
export const TTS_PREPARE_API_VERSION = 1 as const;

export interface CompanionEndpointSnapshot {
  serverName: string;
  endpoints: CompanionEndpoint[];
  ttsPrepareVersion: typeof TTS_PREPARE_API_VERSION;
}
```

`endpointSnapshot()` always sets `ttsPrepareVersion: TTS_PREPARE_API_VERSION`. Do not forward this object to the Hub. Do not put the version on `GET /api/config`.

iOS `CompanionConnectionMetadata` adds `ttsPrepareVersion: Int?` via `decodeIfPresent`. Missing/null/non-int → nil. Decode of endpoints must still succeed for old sidecars (today’s fixtures have no version). `CallModePolicy.companionPrepareAllowed(ttsPrepareVersion:)` is the only call gate.

Engine capability payload (Task 9). Add to `VBotEngineCapabilities` in `server/vbot-engine-sync.ts`:

```ts
export interface VBotEngineCapabilities {
  readonly roster: boolean;
  readonly sendPrompt: boolean;
  readonly transcriptTail: boolean;
  readonly events: boolean;
  readonly attachments: boolean;
  readonly queueing: boolean;
  readonly steer: boolean;
  readonly stop: boolean;
  readonly mcp: boolean;
  readonly computer: boolean;
  readonly localVm: boolean;
  /** Native room/group-call support for this selected engine. Not roster presence. */
  readonly groups: boolean;
}
```

`openMausEngineCapabilities()` sets `groups: true` (OpenMaus already has `/api/groups/:id/messages`). `reconstructedEngineCapabilities()` sets `groups: false`. Do **not** set reconstructed `groups` from `probe.roster.groups.length`. Do **not** add a reconstructed `groups` probe field in this MVP. Do **not** AND Hermes into OpenMaus `engineCapabilities.groups` (Hermes is not the primary engine; a workspace can still have non-Hermes rooms). Hermes stays on `capabilities.hermesBot` as `describeProviderInstances()` already copies `hermes.capabilities` including `groups: false`.

iOS decode (fail-closed, compatible with today’s Hub payloads that omit `groups` and with older payloads that omit `engineCapabilities` entirely):

```swift
public struct VBotEngineCapabilities: Codable, Hashable, Sendable {
    public var roster: Bool?
    public var sendPrompt: Bool?
    public var transcriptTail: Bool?
    public var events: Bool?
    public var attachments: Bool?
    public var queueing: Bool?
    public var steer: Bool?
    public var stop: Bool?
    public var mcp: Bool?
    public var computer: Bool?
    public var localVm: Bool?
    public var groups: Bool?

    public var supportsNativeRoomCalls: Bool { groups == true }
}

public struct HermesBotCapabilityFlags: Codable, Hashable, Sendable {
    public var groups: Bool?
}

public struct HermesBotAdvertisement: Codable, Hashable, Sendable {
    public var capabilities: HermesBotCapabilityFlags?
}

// InstanceCapabilities adds: public var hermesBot: HermesBotAdvertisement?
// VBotEngineSync adds: public var engineCapabilities: VBotEngineCapabilities?
```

`VBotEngineSync.openMausOnly.engineCapabilities` is `nil` (stub without a fetched payload → `nativeRoomCallSupported` fails closed). Extra JSON keys remain ignored. A payload that includes `engineCapabilities` without `groups` decodes; `groups == true` is false.

Desktop `src/lib/vbot-engine.ts` does not parse `engineCapabilities` today. Do not add a desktop parser in this MVP.

Desktop constants to copy, not reinvent:

- `CALL_ENDPOINT_MS = 850` → `CallModePolicy.endpointMs`
- Group spoken-address routing behavior from `src/lib/group-call.ts` (longest-name-first)

Desktop constants **not** to copy onto iOS:

- Approval YES/NO prefix regexes (see above). Phrase lists only; whole-utterance match on the phone.

---

### Task 1: Companion Prepare Allowlist, Sidecar Handshake, and Feature Flag

**Files:**
- Modify: `companion/src/routes.ts` (allowlist near the existing TTS entries around lines 708–711)
- Modify: `companion/test/routes.test.ts` (allowed-route table around lines 141–142)
- Modify: `companion/src/proxy.ts` (`CompanionEndpointSnapshot` around line 122, `endpointSnapshot()` around line 264)
- Modify: `companion/test/proxy.test.ts` (endpoint snapshot exact-match around lines 741–759)
- Modify: `server/config.ts` (`featureConfigSchema` around line 67 and `AppConfig.features`)
- Modify: `server/index.ts` (`configStatus()` around line 4025)
- Modify: `server/config.test.ts`
- Modify: `src/lib/feature-flags.ts`
- Modify: `src/lib/feature-flags.test.ts`
- Modify: `ios/Sources/CompanionCore/Models.swift` (`ConfigStatus`, `CompanionConnectionMetadata`)
- Modify: `ios/Tests/CompanionCoreTests/EndpointRefreshTests.swift`
- Test: `companion/test/routes.test.ts`
- Test: `companion/test/proxy.test.ts`
- Test: `src/lib/feature-flags.test.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: existing companion allowlist classifier `denyReason`, existing phone-readable `GET /api/config`, existing sidecar `GET /api/companion/endpoints`.
- Produces: paired devices may `POST /api/tts/prepare`. Sidecar snapshot includes `ttsPrepareVersion: 1`. `iosVoiceCallsEnabled(config)` is true only when `features.iosVoiceCalls === true`. Hub `configStatus().features` includes that boolean. The hub flag does **not** set `companionPrepareAllowed`. Unauthenticated devices still cannot hit TTS. Phone still cannot PATCH `/api/config`. Optional `ConfigStatus.features.iosVoiceCalls: Bool?` on iOS. Optional `CompanionConnectionMetadata.ttsPrepareVersion: Int?`.

- [ ] **Step 1: Write the failing allowlist, handshake, and flag tests**

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

Add to the existing `GET /api/companion/endpoints` proxy test, alongside the current `serverName` / `endpoints` assertions (exact equality must include the new field):

```ts
expect(await direct.json()).toEqual({
  serverName: "Test computer",
  endpoints: [{ kind: "lan", priority: 200, url: "http://192.168.1.42:8810" }],
  ttsPrepareVersion: 1,
});
expect(JSON.stringify(await (await load(TOKEN)).json())).not.toMatch(/iosVoiceCalls/);
```

iOS compatibility tests in `EndpointRefreshTests.swift`. Old fixtures must keep decoding; do not call `CallModePolicy` here (that type is Task 2).

```swift
func testOldSidecarEndpointSnapshotOmitsPrepareVersion() throws {
    let old = try JSONDecoder().decode(
        CompanionConnectionMetadata.self,
        from: Data(#"{"serverName":"Mac","endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200}]}"#.utf8)
    )
    XCTAssertNil(old.ttsPrepareVersion)
}

func testSidecarPrepareVersionDecodesWhenAdvertised() throws {
    let ready = try JSONDecoder().decode(
        CompanionConnectionMetadata.self,
        from: Data(#"{"serverName":"Mac","endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200}],"ttsPrepareVersion":1}"#.utf8)
    )
    XCTAssertEqual(ready.ttsPrepareVersion, 1)
}
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm exec vitest run companion/test/routes.test.ts companion/test/proxy.test.ts src/lib/feature-flags.test.ts server/config.test.ts`

Then: `swift test --package-path ios --filter EndpointRefreshTests`

Expected: FAIL because prepare is not allowlisted, snapshot has no `ttsPrepareVersion`, `iosVoiceCallsEnabled` is undefined, Hub config rejects/omits the flag, and iOS metadata has no `ttsPrepareVersion`.

- [ ] **Step 3: Add the allowlist entry, sidecar version, and flag helper**

Add `{ method: "POST", path: /^\/api\/tts\/prepare$/ }` next to the existing TTS rows. Comment that the route returns utterance strings only, never the ElevenLabs key.

In `companion/src/proxy.ts`, export `TTS_PREPARE_API_VERSION = 1` and add `ttsPrepareVersion: TTS_PREPARE_API_VERSION` to `CompanionEndpointSnapshot` and the `return` of `endpointSnapshot()`. Keep the existing URL/kind/priority caps. Do not add Hub feature flags, paths, or tokens to this object. Update every exact `toEqual({ serverName, endpoints })` snapshot assertion in `companion/test/proxy.test.ts` (three around lines 741–759) to include `ttsPrepareVersion: 1`.

Add `iosVoiceCalls: z.boolean().optional()` to `featureConfigSchema`, keep existing `browser` on `FeatureFlagConfig.features`, and emit `iosVoiceCalls: iosVoiceCallsEnabled(cfg)` beside `skillRecorder` in `configStatus()`. Implement:

```ts
export function iosVoiceCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.iosVoiceCalls === true;
}
```

Extend `FeatureFlagConfig.features` to `{ skillRecorder?: boolean; browser?: boolean; iosVoiceCalls?: boolean }`. Keep a Hub helper in `server/config.ts` with the same default-false rule as `skillRecorderEnabled`. On iOS `ConfigStatus`, add an optional nested flags object (do not put `iosVoiceCalls` on the root):

```swift
public struct ConfigFeatureFlags: Codable, Sendable {
    public var iosVoiceCalls: Bool?
}
// ConfigStatus.features: ConfigFeatureFlags?
```

Do not default it on. The phone reads the flag from `GET /api/config`; the owner turns it on from desktop Settings / config PATCH, which stays Mac-only. `flagged` is `features?.iosVoiceCalls == true`. That is not `companionPrepareAllowed`.

Decode optional `ttsPrepareVersion` on `CompanionConnectionMetadata` with `decodeIfPresent`. This struct already has a custom `init(from:)` — add `ttsPrepareVersion` to `CodingKeys` and assign `try container.decodeIfPresent(Int.self, forKey: .ttsPrepareVersion)` there. Do not throw when it is missing. Do not rewrite the endpoint-route decoder. `Failover.reconcile` ignores the version (routing unchanged).

- [ ] **Step 4: Re-run the focused tests**

Expected: PASS. `GET /api/config` remains allowed (booleans only). `PATCH /api/config` and `/api/instances` still deny from the phone. Hub config accepts `{ features: { iosVoiceCalls: true } }` and defaults false. Endpoint snapshot includes `ttsPrepareVersion: 1` and still strips unknown candidate fields. Old iOS fixtures without the version still decode. Hub flag and sidecar version remain independent fields.

- [ ] **Step 5: Commit**

Commit message: `feat(companion): allow TTS prepare for iOS calls`

---

### Task 2: Call Mode Policy (testable, no microphone)

**Files:**
- Create: `ios/Sources/CompanionCore/CallModePolicy.swift`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: locked `CallPhase`, `CallTarget`, `CallAvailability`, `CallEvent`.
- Produces: `CallModePolicy.reduce(phase:availability:awaitingSpokenDecision:event:) -> CallPhase`, `CallModePolicy.availability(...)` with locked `reason*` copy, `companionPrepareAllowed(ttsPrepareVersion:)`, `allowsRoomCall(isDm:engineSupportsGroups:visibleMemberCount:)`, `micOpen`, `allowsOpenMicDuringPlayback`, `allowsNativeCall(mutationTarget:)`. Mic-open is true only in `listening`. Reducer table in Interfaces is the implementation spec. Empty `memberVoices` cannot make `voiceReady` when `requireEveryMemberVoice` is true.

- [ ] **Step 1: Write failing policy tests**

Every `reduce` call passes `availability:` (the ready fixture or a deliberate blocked one). Do not add a `reduce` overload that omits it.

```swift
private func readyAvailability() -> CallAvailability {
    CallModePolicy.availability(
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
}

func testMicIsClosedDuringPlaybackAndSending() {
    XCTAssertTrue(CallModePolicy.micOpen(phase: .listening, awaitingSpokenDecision: false))
    XCTAssertTrue(CallModePolicy.micOpen(phase: .listening, awaitingSpokenDecision: true))
    XCTAssertFalse(CallModePolicy.micOpen(phase: .speaking, awaitingSpokenDecision: false))
    XCTAssertFalse(CallModePolicy.micOpen(phase: .sending, awaitingSpokenDecision: false))
    XCTAssertFalse(CallModePolicy.micOpen(phase: .working, awaitingSpokenDecision: false))
}

func testBusyClosesMicUnlessASpokenApprovalIsOpen() {
    XCTAssertEqual(
        CallModePolicy.reduce(
            phase: .listening,
            availability: readyAvailability(),
            awaitingSpokenDecision: false,
            event: .botBusy(true, speakerBotId: "b1")
        ),
        .working
    )
    XCTAssertEqual(
        CallModePolicy.reduce(
            phase: .listening,
            availability: readyAvailability(),
            awaitingSpokenDecision: true,
            event: .botBusy(true, speakerBotId: "b1")
        ),
        .listening
    )
}

func testTapInterruptLeavesSpeakingAndReopensListen() {
    XCTAssertEqual(
        CallModePolicy.reduce(
            phase: .speaking,
            availability: readyAvailability(),
            awaitingSpokenDecision: false,
            event: .tapInterrupt
        ),
        .listening
    )
}

func testBackgroundLockAndRevokedPairingHangUp() {
    for event: CallEvent in [.backgrounded, .pairingRevoked, .hangUp] {
        XCTAssertEqual(
            CallModePolicy.reduce(
                phase: .listening,
                availability: readyAvailability(),
                awaitingSpokenDecision: false,
                event: event
            ),
            .ended
        )
        XCTAssertFalse(CallModePolicy.micOpen(phase: .ended, awaitingSpokenDecision: true))
    }
}

func testLostAvailabilityHangsUp() {
    let unpaired = CallModePolicy.availability(
        flagged: true,
        speechAvailable: true,
        ttsConfigured: true,
        agentVoice: "voice-1",
        workspaceDefaultVoice: false,
        requireEveryMemberVoice: false,
        memberVoices: ["voice-1"],
        companionPrepareAllowed: true,
        foreground: true,
        paired: false
    )
    XCTAssertEqual(
        CallModePolicy.reduce(
            phase: .listening,
            availability: unpaired,
            awaitingSpokenDecision: false,
            event: .capturePartial("hi")
        ),
        .ended
    )
}

func testStartIsRejectedWhenAvailabilityCannotStart() {
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
    XCTAssertEqual(
        CallModePolicy.reduce(
            phase: .idle,
            availability: blocked,
            awaitingSpokenDecision: false,
            event: .start(CallTarget(id: "b", threadId: "t", isRoom: false, name: "Bot", voices: ["voice-1"]))
        ),
        .idle
    )
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
    XCTAssertEqual(missing.reason, CallModePolicy.reasonEveryMemberVoice)
}

func testEmptyRoomCannotStartATeamCall() {
    let empty = CallModePolicy.availability(
        flagged: true,
        speechAvailable: true,
        ttsConfigured: true,
        agentVoice: nil,
        workspaceDefaultVoice: true,
        requireEveryMemberVoice: true,
        memberVoices: [],
        companionPrepareAllowed: true,
        foreground: true,
        paired: true
    )
    XCTAssertFalse(empty.voiceReady)
    XCTAssertFalse(empty.canStart)
    XCTAssertEqual(empty.reason, CallModePolicy.reasonEmptyRoom)
    XCTAssertFalse(CallModePolicy.allowsRoomCall(isDm: false, engineSupportsGroups: true, visibleMemberCount: 0))
}

func testAvailabilityReasonCopyIsLockedAndFirstFailingGateWins() {
    func availability(
        flagged: Bool = true,
        speechAvailable: Bool = true,
        ttsConfigured: Bool = true,
        agentVoice: String? = "voice-1",
        workspaceDefaultVoice: Bool = false,
        requireEveryMemberVoice: Bool = false,
        memberVoices: [String?] = ["voice-1"],
        companionPrepareAllowed: Bool = true,
        foreground: Bool = true,
        paired: Bool = true
    ) -> CallAvailability {
        CallModePolicy.availability(
            flagged: flagged,
            speechAvailable: speechAvailable,
            ttsConfigured: ttsConfigured,
            agentVoice: agentVoice,
            workspaceDefaultVoice: workspaceDefaultVoice,
            requireEveryMemberVoice: requireEveryMemberVoice,
            memberVoices: memberVoices,
            companionPrepareAllowed: companionPrepareAllowed,
            foreground: foreground,
            paired: paired
        )
    }

    XCTAssertEqual(availability().reason, "")
    XCTAssertEqual(availability(paired: false).reason, CallModePolicy.reasonReconnect)
    XCTAssertEqual(availability(foreground: false).reason, CallModePolicy.reasonForeground)
    XCTAssertEqual(availability(flagged: false).reason, CallModePolicy.reasonFlagOff)
    XCTAssertEqual(availability(companionPrepareAllowed: false).reason, CallModePolicy.reasonCompanionPrepare)
    XCTAssertEqual(availability(speechAvailable: false).reason, CallModePolicy.reasonSpeechUnavailable)
    XCTAssertEqual(availability(ttsConfigured: false).reason, CallModePolicy.reasonTtsUnconfigured)
    XCTAssertEqual(
        availability(agentVoice: nil, workspaceDefaultVoice: false).reason,
        CallModePolicy.reasonChooseVoice
    )
    XCTAssertEqual(
        availability(flagged: false, paired: false).reason,
        CallModePolicy.reasonReconnect,
        "paired is checked before flagged"
    )
    XCTAssertEqual(
        availability(flagged: false, companionPrepareAllowed: false).reason,
        CallModePolicy.reasonFlagOff,
        "flagged is checked before sidecar prepare"
    )
}

func testHubFlagDoesNotImplySidecarPrepare() {
    XCTAssertEqual(CallModePolicy.requiredTtsPrepareVersion, 1)
    XCTAssertTrue(CallModePolicy.companionPrepareAllowed(ttsPrepareVersion: 1))
    XCTAssertFalse(CallModePolicy.companionPrepareAllowed(ttsPrepareVersion: nil))
    XCTAssertFalse(CallModePolicy.companionPrepareAllowed(ttsPrepareVersion: 0))
    XCTAssertFalse(CallModePolicy.companionPrepareAllowed(ttsPrepareVersion: 2))
    let flaggedWithoutSidecar = CallModePolicy.availability(
        flagged: true,
        speechAvailable: true,
        ttsConfigured: true,
        agentVoice: "voice-1",
        workspaceDefaultVoice: false,
        requireEveryMemberVoice: false,
        memberVoices: ["voice-1"],
        companionPrepareAllowed: CallModePolicy.companionPrepareAllowed(ttsPrepareVersion: nil),
        foreground: true,
        paired: true
    )
    XCTAssertFalse(flaggedWithoutSidecar.canStart)
    XCTAssertEqual(flaggedWithoutSidecar.reason, CallModePolicy.reasonCompanionPrepare)
}

func testFullDuplexIsRejected() {
    XCTAssertFalse(CallModePolicy.allowsOpenMicDuringPlayback)
}

func testReconstructedEngineIsNotACallTarget() {
    XCTAssertTrue(CallModePolicy.allowsNativeCall(mutationTarget: .openmaus))
    XCTAssertFalse(CallModePolicy.allowsNativeCall(mutationTarget: .grokReconstructed))
}

func testReducerCaptureSpeakPlaybackBusyInterruptMatrix() {
    let ready = readyAvailability()
    func reduce(_ phase: CallPhase, _ event: CallEvent, awaiting: Bool = false) -> CallPhase {
        CallModePolicy.reduce(phase: phase, availability: ready, awaitingSpokenDecision: awaiting, event: event)
    }

    XCTAssertEqual(reduce(.listening, .captureFinal("hello")), .sending)
    XCTAssertEqual(reduce(.listening, .captureFinal("  ")), .listening)
    XCTAssertEqual(reduce(.speaking, .captureFinal("hello")), .speaking)
    XCTAssertEqual(reduce(.working, .captureFinal("hello")), .working)
    XCTAssertEqual(reduce(.sending, .captureFinal("hello")), .sending)
    XCTAssertEqual(reduce(.idle, .captureFinal("hello")), .idle)

    XCTAssertEqual(reduce(.listening, .captureFailed("denied")), .listening)
    XCTAssertEqual(reduce(.speaking, .captureFailed("denied")), .speaking)
    XCTAssertEqual(reduce(.working, .captureFailed("denied")), .working)
    XCTAssertFalse(CallModePolicy.micOpen(phase: .speaking, awaitingSpokenDecision: false))

    XCTAssertEqual(reduce(.listening, .speakText("hi", botId: "b", voiceId: "v", messageId: "m")), .speaking)
    XCTAssertEqual(reduce(.working, .speakText("hi", botId: "b", voiceId: nil, messageId: nil)), .speaking)
    XCTAssertEqual(reduce(.sending, .speakText("hi", botId: nil, voiceId: nil, messageId: nil)), .speaking)
    XCTAssertEqual(reduce(.idle, .speakText("hi", botId: "b", voiceId: "v", messageId: nil)), .idle)
    XCTAssertFalse(CallModePolicy.micOpen(phase: .speaking, awaitingSpokenDecision: true))

    XCTAssertEqual(reduce(.speaking, .playbackFinished), .working)
    XCTAssertEqual(reduce(.speaking, .playbackFinished, awaiting: true), .listening)
    XCTAssertEqual(reduce(.listening, .playbackFinished), .listening)
    XCTAssertEqual(reduce(.working, .playbackFinished), .working)

    XCTAssertEqual(reduce(.working, .botBusy(false, speakerBotId: nil)), .listening)
    XCTAssertEqual(reduce(.sending, .botBusy(false, speakerBotId: nil)), .listening)
    XCTAssertEqual(reduce(.speaking, .botBusy(false, speakerBotId: "b1")), .speaking)
    XCTAssertEqual(reduce(.listening, .botBusy(false, speakerBotId: nil)), .listening)
    XCTAssertEqual(reduce(.speaking, .botBusy(true, speakerBotId: "b1")), .speaking)
    XCTAssertEqual(reduce(.sending, .botBusy(true, speakerBotId: "b1")), .working)

    XCTAssertEqual(reduce(.speaking, .tapInterrupt), .listening)
    XCTAssertEqual(reduce(.working, .tapInterrupt), .listening)
    XCTAssertEqual(reduce(.sending, .tapInterrupt), .listening)
    XCTAssertEqual(reduce(.listening, .tapInterrupt), .listening)
    XCTAssertEqual(reduce(.idle, .tapInterrupt), .idle)
    XCTAssertEqual(
        CallModePolicy.reduce(phase: .ended, availability: ready, awaitingSpokenDecision: false, event: .tapInterrupt),
        .ended
    )
}
```

- [ ] **Step 2: Run the suite and confirm failures**

Run: `swift test --package-path ios --filter CallModePolicyTests`
Expected: FAIL because `CallModePolicy` does not exist.

- [ ] **Step 3: Implement the minimal reducer**

Keep it pure. `allowsOpenMicDuringPlayback` is a `static let` of `false` so a future AEC patch has to change an explicit flag and the test above. Room availability copies desktop `requireExplicitVoices`: workspace fallback is not enough when several members speak, and `memberVoices` must be nonempty. There is one `reduce` signature; tests and both overlays call it with `availability` every time. Implement the locked reducer table verbatim, including fail-closed stay-in-phase for stray `captureFinal` during `.speaking` and `botBusy(false)` that does not leave `.speaking`. `allowsNativeCall(.grokReconstructed)` is false. `availability.reason` uses the locked first-failing-gate constants; overlays display `availability.reason` verbatim. `companionPrepareAllowed(ttsPrepareVersion:)` is independent of `flagged`. `allowsRoomCall` takes `visibleMemberCount` and rejects `0`.

- [ ] **Step 4: Re-run the suite**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add half-duplex call policy`

---

### Task 3: Spoken Approvals and Group Address Routing

**Files:**
- Create: `ios/Sources/CompanionCore/GroupCallRouting.swift`
- Modify: `ios/Sources/CompanionCore/CallModePolicy.swift` (`approvalDecision`, prompt/deny copy)
- Test: `ios/Tests/CompanionCoreTests/GroupCallRoutingTests.swift`
- Modify: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: desktop `routeSpokenGroupMessage` contract; yes/no **phrase lists** from Interfaces, not the desktop regex.
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

func testApprovalYesNoIsWholeUtteranceAfterTrim() {
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "yes"), .allow)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "Yes!"), .allow)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "  nope. "), .deny)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "don't"), .deny)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "please do"), .allow)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "sure, and also delete the folder"), .reask)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "yes please delete everything"), .reask)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "please do it"), .reask)
    XCTAssertEqual(CallModePolicy.approvalDecision(from: "please look at the logs"), .reask)
}
```

The `yes please delete everything` and `please do it` cases are the ones the desktop prefix regex would grant. iOS must re-ask.

Mentions-mode rooms: if `addressed == false`, do not send; the UI asks the user to name a member or say “everyone”. Lead-bot rooms send unaddressed speech to the default responder, matching desktop `GroupCallView.tsx`.

- [ ] **Step 2: Run focused tests**

Run: `swift test --package-path ios --filter GroupCallRoutingTests --filter CallModePolicyTests`
Expected: FAIL on missing `GroupCallRouting` / approval helper.

- [ ] **Step 3: Implement the port**

Copy desktop **group-address** regex behavior, including longest-name-first so “Deep Research” wins over “Deep”.

Do **not** copy the desktop approval regex. Implement `approvalDecision` with the locked trim-then-exact-match algorithm. Put the helper in CompanionCore so Task 7 (1:1) and Task 8 (team) both call it; neither overlay parses yes/no itself.

Spoken approval copy (1:1): `CallModePolicy.permissionPrompt`
Spoken question copy: `CallModePolicy.questionPrompt`
Reask copy: `CallModePolicy.reaskPrompt`
Deny message: `CallModePolicy.denyMessage(isRoom:)`

- [ ] **Step 4: Re-run focused tests**

Expected: PASS. Also run `pnpm exec vitest run src/lib/group-call.test.ts` and keep both **routing** tables in sync if you have to tweak a case. Do not change desktop YES/NO regexes to match iOS in this task.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): route spoken group turns and approvals`

---

### Task 4: TTS Prepare Client and Playback Contract

**Files:**
- Create: `ios/Sources/CompanionCore/CallSpeaker.swift` (`CallAudioPlaying`, `CallSpeaker`, `assertSpeakable`)
- Modify: `ios/Sources/CompanionCore/Client.swift` (add `prepareSpeech` and `synthesizeSpeech` next to `previewVoice` around line 1532)
- Create: `ios/App/CallAudioPlayer.swift` (App-target `CallAudioPlaying` conformer)
- Test: `ios/Tests/CompanionCoreTests/VoiceClientTests.swift`

**Interfaces:**
- Consumes: `POST /api/tts/prepare` and `POST /api/tts/speak`.
- Produces: `CompanionClient.prepareSpeech(text:voiceId:)`, `CompanionClient.synthesizeSpeech(text:voiceId:)` (shared omit-nil `voiceId` body), `CallSpeaker.assertSpeakable` (`utf16.count` vs 500), `CallSpeaker.speak` / `stop`, `CallAudioPlaying.play` / `cancel`, `CallAudioPlayer: NSObject, AVAudioPlayerDelegate, CallAudioPlaying`.

- [ ] **Step 1: Write failing HTTP and speaker tests**

Use the same URLProtocol stub pattern as `Wave35ClientTests` / `ProfileClientTests` (`CompanionClient` + ephemeral `URLSession`). Do not hit a live Hub.

```swift
final class FakeCallAudioPlayer: CallAudioPlaying {
    var played: [Data] = []
    private var continuation: CheckedContinuation<Bool, Never>?

    func play(_ data: Data) async -> Bool {
        played.append(data)
        return await withCheckedContinuation { continuation = $0 }
    }

    func cancel() {
        continuation?.resume(returning: false)
        continuation = nil
    }

    func finishCurrent() {
        continuation?.resume(returning: true)
        continuation = nil
    }
}

func testPreparePostsTextAndVoice() async throws {
    VoiceRequestStub.responseBody = Data(#"{"ready":true,"utterances":["Hello world"]}"#.utf8)
    let prepared = try await client.prepareSpeech(text: "Hello **world**", voiceId: "v1")
    XCTAssertEqual(VoiceRequestStub.capturedRequest?.url?.path, "/api/tts/prepare")
    XCTAssertEqual(VoiceRequestStub.capturedRequest?.httpMethod, "POST")
    let body = try JSONSerialization.jsonObject(with: VoiceRequestStub.capturedBody!) as! [String: Any]
    XCTAssertEqual(body["text"] as? String, "Hello **world**")
    XCTAssertEqual(body["voiceId"] as? String, "v1")
    XCTAssertEqual(prepared, PreparedSpeech(ready: true, utterances: ["Hello world"]))
}

func testSynthesizePostsSpeakAndReturnsBytes() async throws {
    VoiceRequestStub.responseBody = Data("RIFF".utf8)
    let data = try await client.synthesizeSpeech(text: "Hello world", voiceId: "v1")
    XCTAssertEqual(VoiceRequestStub.capturedRequest?.url?.path, "/api/tts/speak")
    let speakBody = try JSONSerialization.jsonObject(with: VoiceRequestStub.capturedBody!) as! [String: Any]
    XCTAssertEqual(speakBody["text"] as? String, "Hello world")
    XCTAssertEqual(speakBody["voiceId"] as? String, "v1")
    XCTAssertEqual(data, Data("RIFF".utf8))
}

func testSpeakRejectsOversizeUtterancesBeforeTheWire() {
    XCTAssertThrowsError(try CallSpeaker.assertSpeakable(String(repeating: "x", count: 501))) { error in
        guard case CallSpeaker.SpeakError.tooLong(501) = error else {
            return XCTFail("expected tooLong(501)")
        }
    }
    XCTAssertNoThrow(try CallSpeaker.assertSpeakable(String(repeating: "x", count: 500)))
    XCTAssertEqual(CallSpeaker.maxSpeakUTF16CodeUnits, 500)
    // Hub `text.length` is UTF-16 code units. U+1F44D is one Swift Character, two UTF-16 units.
    let thumbsOver = String(repeating: "👍", count: 251)
    XCTAssertEqual(thumbsOver.count, 251)
    XCTAssertEqual(thumbsOver.utf16.count, 502)
    XCTAssertThrowsError(try CallSpeaker.assertSpeakable(thumbsOver)) { error in
        guard case CallSpeaker.SpeakError.tooLong(502) = error else {
            return XCTFail("expected tooLong(502) utf16, not grapheme count")
        }
    }
    XCTAssertNoThrow(try CallSpeaker.assertSpeakable(String(repeating: "👍", count: 250)))
}

func testPrepareAndSynthesizeOmitNilAndEmptyVoiceId() async throws {
    VoiceRequestStub.responseBody = Data(#"{"ready":true,"utterances":["Hi"]}"#.utf8)
    _ = try await client.prepareSpeech(text: "Hi", voiceId: nil)
    var body = try JSONSerialization.jsonObject(with: VoiceRequestStub.capturedBody!) as! [String: Any]
    XCTAssertEqual(body["text"] as? String, "Hi")
    XCTAssertNil(body["voiceId"])

    VoiceRequestStub.responseBody = Data(#"{"ready":true,"utterances":["Hi"]}"#.utf8)
    _ = try await client.prepareSpeech(text: "Hi", voiceId: "  ")
    body = try JSONSerialization.jsonObject(with: VoiceRequestStub.capturedBody!) as! [String: Any]
    XCTAssertNil(body["voiceId"])

    VoiceRequestStub.responseBody = Data("RIFF".utf8)
    _ = try await client.synthesizeSpeech(text: "Hi", voiceId: nil)
    body = try JSONSerialization.jsonObject(with: VoiceRequestStub.capturedBody!) as! [String: Any]
    XCTAssertEqual(body["text"] as? String, "Hi")
    XCTAssertNil(body["voiceId"])

    VoiceRequestStub.responseBody = Data("RIFF".utf8)
    _ = try await client.synthesizeSpeech(text: "Hi", voiceId: "")
    body = try JSONSerialization.jsonObject(with: VoiceRequestStub.capturedBody!) as! [String: Any]
    XCTAssertNil(body["voiceId"])
}

func testStopCancelsPlaybackAndDropsPrefetch() async {
    let player = FakeCallAudioPlayer()
    var synthesizeCount = 0
    let speaker = CallSpeaker(
        prepare: { _, _ in PreparedSpeech(ready: true, utterances: ["one", "two"]) },
        synthesize: { text, _ in
            synthesizeCount += 1
            return Data(text.utf8)
        },
        player: player
    )
    let task = Task { await speaker.speak(text: "one two", voiceId: "v1", botId: "b", messageId: "m") }
    while player.played.isEmpty { await Task.yield() }
    speaker.stop()
    await task.value
    XCTAssertEqual(player.played, [Data("one".utf8)])
    XCTAssertLessThanOrEqual(synthesizeCount, 2)
}
```

- [ ] **Step 2: Run `swift test --package-path ios --filter VoiceClientTests`**

Expected: FAIL.

- [ ] **Step 3: Implement prepare + speaker + player**

`CompanionClient.prepareSpeech` and `synthesizeSpeech` share one body builder:

```swift
func ttsBody(text: String, voiceId: String?) -> [String: Any] {
    var body: [String: Any] = ["text": text]
    if let voiceId, !voiceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        body["voiceId"] = voiceId
    }
    return body
}
```

Both POST with that body. Nil or whitespace `voiceId` omits the key (never `NSNull` / JSON null). Non-empty `voiceId` is sent on both routes. Decode `{ ready, utterances }` from prepare. If `ready == false`, throw the locked 409 copy. `previewVoice` remains for the profile sheet and is not used on the call path.

`CompanionClient.synthesizeSpeech` calls `CallSpeaker.assertSpeakable` then POSTs `/api/tts/speak` with the full text (no `prefix(500)`). Hub 413 remains the server-side backstop. `assertSpeakable` compares `text.utf16.count` to `maxSpeakUTF16CodeUnits` (500), matching Hub `text.length`.

`CallSpeaker` algorithm, copied from `src/lib/tts/index.ts`:

1. `stop()` bumps a generation token, abandons in-flight prepare/synthesize, and calls `player.cancel()`.
2. Prepare once.
3. `assertSpeakable` + synthesize utterance 0; while it `play`s, synthesize utterance 1; continue.
4. Resolve when finished, interrupted, or failed. Failures set `error`; they do not throw.

`CallAudioPlayer` (App target) is `final class CallAudioPlayer: NSObject, AVAudioPlayerDelegate, CallAudioPlaying`. It plays the returned `Data` with `AVAudioPlayer`, matching `AgentProfileView`, and sets `player.delegate = self`. `play` resumes `true` from `audioPlayerDidFinishPlaying(_:successfully: true)`, `false` from `cancel()`, decode failure, or `successfully: false`. Session category while a call is alive is `.playAndRecord` with voiceChat / spokenAudio as needed, then deactivated on hang-up so composer dictation can return to `.record`.

- [ ] **Step 4: Re-run VoiceClientTests**

Expected: PASS. `swift test --package-path ios` still passes (App target is not in this package).

- [ ] **Step 5: Commit**

Commit message: `feat(ios): reuse Hub TTS prepare and speak`

---

### Task 5: Call Capture With Automatic Silence

**Files:**
- Create: `ios/App/CallCapture.swift`
- Do not modify: `ios/App/SpeechDictation.swift`
- Test: document simulator/device gate in `ios/TESTING.md` (updated in Task 10). Logic that can be tested without Speech stays in `CallModePolicy.endpointMs` / `shouldSend`.

**Interfaces:**
- Consumes: `Dictation.localeCandidates()`, `CallModePolicy.endpointMs == 850`, `CallModePolicy.composerEndpointMs == 0`, `CallModePolicy.shouldSend(finalText:intentionalStop:)`.
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
- Consumes: Tasks 2–5, `Session.send(_:to:mode:)` (applies `VBotMutationRouting`; do not call `CompanionClient.send`), SSE-folded messages, `bot.busy`, `tool.spoken`, `CallModePolicy.transfer`, `CallModePolicy.end`, `CallModePolicy.allowsNativeCall`, `CallModePolicy.companionPrepareAllowed(ttsPrepareVersion:)`.
- Produces: one call at a time on `Session.currentCallId: String?`. Overlay with avatar, phase label, caption, Interrupt, Hang up. `Session.ttsPrepareVersion: Int?` in memory from sidecar metadata.

- [ ] **Step 1: Add ownership tests on `CallModePolicy`**

```swift
func testStaleHangUpCannotKillANewerCall() {
    var current: String? = "bot-a"
    current = CallModePolicy.transfer(current: current, to: "bot-b")
    XCTAssertEqual(current, "bot-b")
    XCTAssertFalse(CallModePolicy.end(current: current, targetId: "bot-a"))
    XCTAssertTrue(CallModePolicy.end(current: current, targetId: "bot-b"))
}
```

Mirror `src/lib/call.test.ts`: `end` is ownership-safe; a teardown for A cannot hang up B.

- [ ] **Step 2: Run the ownership tests**

Expected: FAIL until transfer/end helpers exist.

- [ ] **Step 3: Wire the 1:1 overlay**

Loop, matching desktop `CallView.tsx`:

1. Start: if `bot.busy` and no open approval/question → `working`; else `listening` + `CallCapture.start()`. Drive phases with `CallModePolicy.reduce(phase:availability:awaitingSpokenDecision:event:)`. Start `CallCapture` only when `micOpen` is true.
2. Partial transcripts update the caption (`.capturePartial`, no phase change). Final non-empty text → reduce `.captureFinal` → `.sending`, then `Session.send(text, to: .bot(bot))`. Do **not** call `CompanionClient.send`. `VBotMutationRouting` inside `Session.send` is what keeps native OpenMaus routing intact.
3. SSE: newest unseen `kind == text` bot reply is spoken via `CallSpeaker.speak` after reduce `.speakText`; during `working`, newest unseen `tool.spoken` is spoken then reduce `.playbackFinished` (→ `.working` when not awaiting a decision); do not recite the backlog present at start.
4. `bot.busy` true → reduce `.botBusy(true, ...)` (closes mic unless `awaitingSpokenDecision`).
5. After playback finishes: reduce `.playbackFinished`. If the bot is not busy, then reduce `.botBusy(false, ...)` so the phase becomes `.listening` (mic closed during playback; listen only after that). If `awaitingSpokenDecision`, `.playbackFinished` already returns `.listening`.
6. Tap Interrupt: `CallSpeaker.stop()`, `CallCapture.stop(intentional: true)`, then reduce `.tapInterrupt` → `.listening` and `CallCapture.start()`. Do **not** call `Session.interrupt` on a 1:1 tap unless the bot is still `busy` after speech stopped and the product copy says so. Desktop 1:1 interrupt only stops local TTS and reopens the mic; keep that. Group interrupt is Task 8.
7. Hang up / Back / `scenePhase != .active` / `AVAudioSession` interruption / pairing loss → `ended` only if `CallModePolicy.end(current:targetId:)` is true; stop capture, stop speaker, deactivate session.
8. Call button sits in chat chrome next to the existing overflow. Hidden when `allowsNativeCall(mutationTarget: VBotMutationRouting.target(for: session.engineSync))` is false (reconstructed is reference-only, not a call target). Disabled state uses `CallAvailability.reason` verbatim (never paraphrase). Overlay sets `flagged` from `config.features.iosVoiceCalls == true` and `companionPrepareAllowed` from `CallModePolicy.companionPrepareAllowed(ttsPrepareVersion: session.ttsPrepareVersion)` — a true hub flag with a missing sidecar version stays disabled with `reasonCompanionPrepare`. `Session.refreshConnectionMetadata` assigns `ttsPrepareVersion` from the snapshot (nil on 404/decode miss/disconnect). Do not persist it on `Connection`. DMs that are 1:1 bots use this view; `group.dm == true` rooms do not get a team call button.

Original V Bot visuals: existing `MausAvatar`, liquid-glass hang-up, no Grok Bot assets. VoiceOver labels: “Call {name}”, “Hang up”, “Interrupt {name}”.

- [ ] **Step 4: Simulator compile**

Run unsigned Debug simulator build for the app target after XcodeGen. `swift test --package-path ios` passes. Microphone quality remains a device gate.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add foreground 1:1 bot calls`

---

### Task 7: Spoken Approval and Question Handling in the Call

**Files:**
- Modify: `ios/Sources/CompanionCore/CallModePolicy.swift` (`shouldTreatSpeechAsApproval`, prompt helpers if not already in Task 3)
- Modify: `ios/App/CallView.swift`
- Modify: `ios/App/Session.swift` if respond/alwaysAllow need a call-specific wrapper
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`
- Do **not** modify `ios/App/GroupCallView.swift` (that file is created in Task 8). Shared approval protocol lives in CompanionCore so Task 8 can call it without this task editing a future file.

**Interfaces:**
- Consumes: `CallModePolicy.approvalDecision`, `CallModePolicy.permissionPrompt`, `CallModePolicy.questionPrompt`, `CallModePolicy.reaskPrompt`, `CallModePolicy.denyMessage(isRoom:)`, `Session.answer(threadId:requestId:choice:isPermission:)` (existing `CompanionClient.respond` wrapper). Do not add a call-specific send/respond path.
- Produces: permission cards spoken and answered with allow/deny only; non-permission `options` cards spoken and answered with the next complete user turn. `shouldTreatSpeechAsApproval(askedRequestId:currentRequestId:)`.

- [ ] **Step 1: Add failing card-state tests**

```swift
func testPermissionCardKeepsMicOpenWhileBusy() {
    let phase = CallModePolicy.reduce(
        phase: .working,
        availability: CallModePolicy.availability(
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
        ),
        awaitingSpokenDecision: true,
        event: .botBusy(true, speakerBotId: "b1")
    )
    XCTAssertEqual(phase, .listening)
}

func testResolvedCardDoesNotKeepFutureSpeechAsConsent() {
    XCTAssertFalse(CallModePolicy.shouldTreatSpeechAsApproval(askedRequestId: "r1", currentRequestId: nil))
    XCTAssertTrue(CallModePolicy.shouldTreatSpeechAsApproval(askedRequestId: "r1", currentRequestId: "r1"))
}
```

- [ ] **Step 2: Run the tests**

Expected: FAIL until those helpers exist.

- [ ] **Step 3: Implement the desktop card loop in CompanionCore + 1:1 UI**

When an unseen permission card appears and phase is not `speaking`, speak `permissionPrompt`, set `awaitingSpokenDecision`, then listen. Yes → `Session.answer(threadId:requestId:choice:"Allow", isPermission: true)`. No → `Session.answer(..., choice: "Deny", isPermission: true, message: CallModePolicy.denyMessage(isRoom: false))`. Add optional `message: String? = nil` to the existing `Session.answer(threadId:requestId:choice:isPermission:)` and pass it through to `CompanionClient.respond` for allow/deny; composer and Live Activity callers omit it. Anything else → reduce `.speakText` for `reaskPrompt` (do not dispatch `.captureFinal`) and listen again. If another client answers the card, clear `askedRequestId`. `shouldTreatSpeechAsApproval` is what prevents a later turn from being treated as consent.

Non-permission questions: speak `questionPrompt`, then the next final transcript is `Session.answer(..., choice: said, isPermission: false)` (existing answer behavior).

Do not route approval speech through `alwaysAllow`. Do not infer consent from a sentence that merely contains “sure”. Parsing stays in `approvalDecision`; `CallView` only switches on `.allow` / `.deny` / `.reask`. Overlay never calls `CompanionClient.send` or `CompanionClient.respond` directly.

- [ ] **Step 4: Re-run policy tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): speak and answer call approvals`

---

### Task 8: Team Calls and Turn Sequencing

**Files:**
- Create: `ios/App/GroupCallView.swift`
- Modify: `ios/Sources/CompanionCore/CallModePolicy.swift` (`SpeechQueue`, `requiresAddress`, `allowsRoomCall`)
- Modify: `ios/App/ChatChromeView.swift`, `ios/App/ChatView.swift`, `ios/App/Session.swift`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`

**Interfaces:**
- Consumes: `GroupCallRouting.route`, `CallModePolicy.approvalDecision`, `CallModePolicy.denyMessage(isRoom: true)`, `Session.send(_:to:mode:)` (not `CompanionClient.send`), `Session.interrupt(chat:)`, `room.busyBotId`, per-member `bot.voice`, `CallModePolicy.allowsNativeCall`, `nativeRoomCallSupported`.
- Produces: `CallModePolicy.SpeechQueue` with optional `botId`, `requiresAddress(defaultResponderKind:)`, `allowsRoomCall(isDm:engineSupportsGroups:visibleMemberCount:)`. One queued speaker at a time; a fast second member cannot cut off the first except via tap interrupt. Visible members are `room.memberIds.compactMap { session.state.bot($0) }.filter { $0.hidden != true }`.

- [ ] **Step 1: Write failing queue tests**

```swift
func testGroupSpeechQueueIsFIFO() {
    var queue = CallModePolicy.SpeechQueue()
    queue.enqueue("working", botId: "a", speakerLabel: "Atlas")
    queue.enqueue("done", botId: "b", speakerLabel: "Research")
    XCTAssertEqual(queue.next()?.botId, "a")
    XCTAssertEqual(queue.next()?.botId, "b")
}

func testMissingSpokenSenderUsesFallbackNotInventedMember() {
    var queue = CallModePolicy.SpeechQueue()
    queue.enqueue("searching the docs", botId: nil, voiceId: nil)
    let item = queue.next()
    XCTAssertNil(item?.botId)
    XCTAssertNil(item?.voiceId)
    XCTAssertEqual(item?.speakerLabel, CallModePolicy.unnamedSpeakerLabel)
    XCTAssertEqual(CallModePolicy.unnamedSpeakerLabel, "Channel member")
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
    XCTAssertFalse(CallModePolicy.requiresAddress(defaultResponderKind: "everyone"))
}

func testDmRoomsHaveNoTeamCall() {
    XCTAssertFalse(CallModePolicy.allowsRoomCall(isDm: true, engineSupportsGroups: true, visibleMemberCount: 2))
    XCTAssertTrue(CallModePolicy.allowsRoomCall(isDm: false, engineSupportsGroups: true, visibleMemberCount: 2))
    XCTAssertFalse(CallModePolicy.allowsRoomCall(isDm: false, engineSupportsGroups: true, visibleMemberCount: 0))
}
```

- [ ] **Step 2: Run the tests**

Expected: FAIL.

- [ ] **Step 3: Implement the team overlay**

Match `GroupCallView.tsx`, calling the CompanionCore helpers from Tasks 3 and 7 rather than reimplementing yes/no or prompts:

- Button hidden when `allowsNativeCall` is false **or** `room.dm == true` **or** `nativeRoomCallSupported` is false (Task 9). Reconstructed rooms are reference-only; they are not team-call targets. Empty visible roster does **not** hide the button: it stays disabled with `reasonEmptyRoom`. `allowsRoomCall(..., visibleMemberCount: 0)` is still false so `.start` cannot succeed.
- Start requires every **visible** member to have a voice (`requireEveryMemberVoice` with nonempty `memberVoices`). Hidden bots (`hidden == true`) are omitted from `memberVoices` and `visibleMemberCount`.
- Capture finals run through `GroupCallRouting.route`. `requiresAddress` + `addressed == false` → do not send; show “Say a member's name — {names} — or say everyone.” Addressed finals → reduce `.captureFinal` then `Session.send(text, to: .room(room))`. Do **not** call `CompanionClient.send`.
- Enqueue `tool.spoken` and member replies via `SpeechQueue.enqueue(_:botId:voiceId:messageId:speakerLabel:)`. If `members.first(where: { $0.id == from.botId })` is nil, enqueue `botId: nil`, `voiceId: nil`, default `speakerLabel` (`"Channel member"`). Do not invent a `Member` or pick another room member. `sayGeneration` / `queueGeneration` tokens drop stale work. `CallSpeaker.speak` uses the queued `voiceId` (nil → Hub workspace default, same omit rule as prepare/synthesize).
- `busyBotId` keeps phase `working` until the queue drains, then listen after ~140ms (desktop `scheduleListen`) by reducing `.botBusy(false)` only once playback is done. After a user send while the room is still busy, wait ~600ms before listening so the first chip can arrive.
- Tap Interrupt: `queue.interrupt()`, `CallSpeaker.stop()`, `CallCapture.stop(intentional: true)`, if `busyBotId != nil` then `Session.interrupt(chat: .room(room))`, then reduce `.tapInterrupt` and listen. This is still tap barge-in, not voice barge-in.
- Spoken approvals use `approvalDecision` and `denyMessage(isRoom: true)` from CompanionCore, answered through `Session.answer` as in Task 7.
- Caption shows `QueuedSpeech.speakerLabel` (fallback `"Channel member"`, never a fake roster row).
- Same hang-up rules as 1:1 via `CallModePolicy.end`. Only one `Session.currentCallId` globally.

Skip reconstructed/unsupported rooms: `allowsNativeCall` is false for `.grokReconstructed`. If the Hub has no `/api/groups/:id/messages` semantics for that room (already true for reconstructed groups), do not start a call. Combine with `allowsRoomCall(isDm: false, engineSupportsGroups: false, visibleMemberCount: 2)` in Task 9. Chrome copy when `nativeRoomCallSupported` is false: `CallModePolicy.reasonUnsupportedRoomEngine` (`"Team calls need a V Bot room."`). Empty visible roster keeps the button visible and disabled with `reasonEmptyRoom`; `allowsRoomCall(..., visibleMemberCount: 0)` is false so start stays blocked.

- [ ] **Step 4: Run Swift tests and simulator build**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(ios): add half-duplex team calls`

---

### Task 9: Roleplay, Local Models, and Capability Honesty

**Files:**
- Modify: `server/vbot-engine-sync.ts` (`VBotEngineCapabilities`, `openMausEngineCapabilities`, `reconstructedEngineCapabilities`)
- Modify: `server/vbot-engine-sync.test.ts`
- Modify: `ios/Sources/CompanionCore/Models.swift` (`VBotEngineCapabilities`, `VBotEngineSync.engineCapabilities`, `InstanceCapabilities.hermesBot`, `VBotEngineSync.openMausOnly`)
- Modify: `ios/Tests/CompanionCoreTests/EngineSyncTests.swift`
- Modify: `ios/Sources/CompanionCore/CallModePolicy.swift`
- Modify: `ios/App/CallView.swift`, `ios/App/GroupCallView.swift`
- Test: `ios/Tests/CompanionCoreTests/CallModePolicyTests.swift`
- Do **not** hardcode `if engine == .grokReconstructed` or `instanceId == "hermes"` for group-call support. Do **not** change `server/hermes-groups.ts` (membership/dispatch already fail closed). Do **not** AND Hermes `groups` into OpenMaus `engineCapabilities.groups`.

**Interfaces:**
- Consumes: existing bot model selection, persona/instructions, `GET /api/vbot/engine-sync` `engineCapabilities.groups`, `GET /api/instances` `capabilities.hermesBot.capabilities.groups` (already copied by `describeProviderInstances()` when Hermes is enabled), `allowsRoomCall(isDm:engineSupportsGroups:visibleMemberCount:)`, `allowsNativeCall(mutationTarget:)`, `Session.send`.
- Produces: `CallModePolicy.sendPath(isRoom:)`, `CallModePolicy.requiredBridgeCapabilities == []`, `CallModePolicy.allowsNativeCall`, `CallModePolicy.nativeRoomCallSupported(engineGroups:hermesGroups:visibleMemberAdvertisesHermes:)`. Call path that does not special-case engines; unsupported and reconstructed stay hidden because the payload/decode is false, not because of an id table.

- [ ] **Step 1: Write failing honesty, decode, and Hermes tests**

Server (`server/vbot-engine-sync.test.ts`), extend the existing OpenMaus and reconstructed `engineCapabilities` `toMatchObject` blocks:

```ts
it("advertises native group-call support from engine capabilities, not roster shape", () => {
  const openmausSync = buildVBotEngineSync({
    primaryEngine: "openmaus",
    reconstructed: reconstructedUnavailable,
    openmaus,
  });
  expect(openmausSync.engineCapabilities.groups).toBe(true);

  const reconstructedSync = buildVBotEngineSync({
    primaryEngine: "grokReconstructed",
    reconstructed: reconstructedAvailable,
    openmaus,
  });
  expect(reconstructedSync.groups.length).toBeGreaterThan(0);
  expect(reconstructedSync.engineCapabilities.groups).toBe(false);
});
```

iOS `EngineSyncTests.swift` (today’s fixtures omit `engineCapabilities` and must still decode):

```swift
func testMissingEngineCapabilitiesFailClosedForRoomCalls() throws {
    let legacy = try JSONDecoder().decode(
        VBotEngineSync.self,
        from: Data("""
        {
          "primaryEngine":"openmaus",
          "activeSource":"openmaus",
          "fallback":false,
          "engines":[],
          "bots":[],
          "groups":[{"id":"room_1","label":"Ops","memberIds":["bot_1"]}]
        }
        """.utf8)
    )
    XCTAssertNil(legacy.engineCapabilities)
    XCTAssertFalse(legacy.engineCapabilities?.supportsNativeRoomCalls ?? false)
    XCTAssertFalse(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: legacy.engineCapabilities?.groups,
            hermesGroups: nil,
            visibleMemberAdvertisesHermes: false
        )
    )
}

func testEngineCapabilitiesGroupsDefaultsFalseWhenOmitted() throws {
    let partial = try JSONDecoder().decode(
        VBotEngineSync.self,
        from: Data("""
        {
          "primaryEngine":"openmaus",
          "activeSource":"openmaus",
          "fallback":false,
          "engines":[],
          "bots":[],
          "groups":[],
          "engineCapabilities":{
            "roster":true,"sendPrompt":true,"transcriptTail":true,"events":true,
            "attachments":true,"queueing":true,"steer":true,"stop":true,
            "mcp":true,"computer":true,"localVm":true
          }
        }
        """.utf8)
    )
    XCTAssertEqual(partial.engineCapabilities?.groups, nil)
    XCTAssertFalse(partial.engineCapabilities?.supportsNativeRoomCalls ?? true)
}

func testOpenMausGroupsTrueDoesNotHardcodeHermes() throws {
    let sync = try JSONDecoder().decode(
        VBotEngineSync.self,
        from: Data("""
        {
          "primaryEngine":"openmaus",
          "activeSource":"openmaus",
          "fallback":false,
          "engines":[],
          "bots":[],
          "groups":[],
          "engineCapabilities":{
            "roster":true,"sendPrompt":true,"transcriptTail":true,"events":true,
            "attachments":true,"queueing":true,"steer":true,"stop":true,
            "mcp":true,"computer":true,"localVm":true,"groups":true
          }
        }
        """.utf8)
    )
    XCTAssertTrue(sync.engineCapabilities?.supportsNativeRoomCalls ?? false)
    XCTAssertTrue(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: sync.engineCapabilities?.groups,
            hermesGroups: nil,
            visibleMemberAdvertisesHermes: false
        )
    )
}

func testHermesGroupsAdvertisementIsDecodedFailClosed() throws {
    let instance = try JSONDecoder().decode(
        Instance.self,
        from: Data("""
        {
          "instanceId":"local-engine",
          "driverKind":"hermes-bot",
          "snapshot":{"state":"available"},
          "models":{"default":"local","options":[{"id":"local","label":"Local"}]},
          "capabilities":{"hermesBot":{"state":"available","capabilities":{"groups":false}}}
        }
        """.utf8)
    )
    XCTAssertNotNil(instance.capabilities?.hermesBot)
    XCTAssertEqual(instance.capabilities?.hermesBot?.capabilities?.groups, false)
    XCTAssertFalse(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: true,
            hermesGroups: instance.capabilities?.hermesBot?.capabilities?.groups,
            visibleMemberAdvertisesHermes: true
        )
    )
    XCTAssertTrue(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: true,
            hermesGroups: true,
            visibleMemberAdvertisesHermes: true
        )
    )
    let omitted = try JSONDecoder().decode(
        Instance.self,
        from: Data("""
        {
          "instanceId":"local-engine",
          "driverKind":"hermes-bot",
          "snapshot":{"state":"available"},
          "models":{"default":"local","options":[{"id":"local","label":"Local"}]},
          "capabilities":{"hermesBot":{"state":"available","capabilities":{}}}
        }
        """.utf8)
    )
    XCTAssertFalse(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: true,
            hermesGroups: omitted.capabilities?.hermesBot?.capabilities?.groups,
            visibleMemberAdvertisesHermes: true
        )
    )
}
```

Policy tests:

```swift
func testRoleplayAndLocalModelsUseTheNormalSendPath() {
    XCTAssertEqual(CallModePolicy.sendPath(isRoom: false), .botMessage)
    XCTAssertEqual(CallModePolicy.sendPath(isRoom: true), .groupMessage)
}

func testCallDoesNotRequireABridgeTtsCapability() {
    XCTAssertEqual(CallModePolicy.requiredBridgeCapabilities, [])
}

func testUnsupportedGroupEnginesCannotStartATeamCall() {
    XCTAssertFalse(CallModePolicy.allowsRoomCall(isDm: false, engineSupportsGroups: false, visibleMemberCount: 2))
}

func testEmptyVisibleRosterCannotStartATeamCall() {
    XCTAssertFalse(CallModePolicy.allowsRoomCall(isDm: false, engineSupportsGroups: true, visibleMemberCount: 0))
}

func testReconstructedIsReferenceOnlyNotACallEngine() {
    XCTAssertFalse(CallModePolicy.allowsNativeCall(mutationTarget: .grokReconstructed))
    XCTAssertTrue(CallModePolicy.allowsNativeCall(mutationTarget: .openmaus))
}

func testNativeRoomCallReadsCapabilityPayloadNotEngineIds() {
    XCTAssertFalse(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: false,
            hermesGroups: true,
            visibleMemberAdvertisesHermes: false
        )
    )
    XCTAssertTrue(
        CallModePolicy.nativeRoomCallSupported(
            engineGroups: true,
            hermesGroups: false,
            visibleMemberAdvertisesHermes: false
        )
    )
    XCTAssertEqual(CallModePolicy.reasonUnsupportedRoomEngine, "Team calls need a V Bot room.")
}
```

- [ ] **Step 2: Run the tests**

Run: `pnpm exec vitest run server/vbot-engine-sync.test.ts`

Then: `swift test --package-path ios --filter EngineSyncTests --filter CallModePolicyTests`

Expected: FAIL until `groups` exists on the Hub payload, iOS decode, and `nativeRoomCallSupported`.

- [ ] **Step 3: Keep the brain on the Hub and wire the capability source**

Add `groups: true` to `openMausEngineCapabilities()` and `groups: false` to `reconstructedEngineCapabilities()`. Do not read reconstructed roster length. Do not invent a reconstructed probe `groups` field in this MVP.

Decode `engineCapabilities` as optional on `VBotEngineSync`. Nested bools are `decodeIfPresent`; `supportsNativeRoomCalls` is `groups == true`. `openMausOnly.engineCapabilities` stays `nil`. Decode optional `InstanceCapabilities.hermesBot` with optional nested `groups`. Extra keys stay ignored so today’s instances JSON without `hermesBot` still works.

Overlay for a team call (`session.modelCatalog` is the existing `GET /api/instances` cache; `AdvertisedModelCatalog.instance(id:in:)` is the existing lookup):

```swift
let visible = room.memberIds.compactMap { session.state.bot($0) }.filter { $0.hidden != true }
let hermesInstance = visible.lazy.compactMap { bot in
    AdvertisedModelCatalog.instance(id: bot.modelSelection.instanceId, in: session.modelCatalog)
}.first { $0.capabilities?.hermesBot != nil }
let engineSupportsGroups = CallModePolicy.nativeRoomCallSupported(
    engineGroups: session.engineSync?.engineCapabilities?.groups,
    hermesGroups: hermesInstance?.capabilities?.hermesBot?.capabilities?.groups,
    visibleMemberAdvertisesHermes: hermesInstance != nil
)
let allow = CallModePolicy.allowsNativeCall(
    mutationTarget: VBotMutationRouting.target(for: session.engineSync)
) && CallModePolicy.allowsRoomCall(
    isDm: room.dm == true,
    engineSupportsGroups: engineSupportsGroups,
    visibleMemberCount: visible.count
)
```

Look up the member’s advertised instance by `bot.modelSelection.instanceId` against `Instance.instanceId` only to find that row, then read `hermesBot` presence. Do not compare the id to `"hermes"`. If `modelCatalog` has not loaded, `hermesInstance` is nil and the Hermes AND does not fire; OpenMaus `engineCapabilities.groups` remains the engine-level source. Server membership/dispatch already rejects Hermes-bound room members (`server/hermes-groups.ts`).

No speech-to-speech provider. A roleplay bot already has its persona on the Hub; the phone sends transcribed text through `Session.send` (so `VBotMutationRouting` stays intact) and speaks `speech-text.ts` output. A local model (LM Studio, injected Codex/Claude local slugs, Hermes local) is just a slower `working` phase — narration of `tool.spoken` is what keeps the call from sounding dead. If a local model emits no chips, keep the Working spinner; do not fake progress. Reconstructed chats remain reference-only: `allowsNativeCall` is false, so the call button never appears even though `Session.send` could theoretically route a reconstructed 1:1 prompt.

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

Expected: PASS. OpenMaus payload `groups: true` allows a nonempty non-DM room. Reconstructed payload `groups: false` does not, even when synced groups exist. Legacy iOS JSON without `engineCapabilities` does not. A visible member whose instance advertises `hermesBot.capabilities.groups == false` does not. A later Hermes advertisement with `groups: true` would be allowed without an iOS engine-id change.

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
4. Approval: spoken yes/no only after whole-utterance match; “yes!” grants; “sure, and also …” and “yes please delete everything” re-ask.
5. Team: name a member, hear that member, then a second member only after the first finishes.
6. Mentions-mode room refuses unaddressed speech with a name hint.
7. Background, lock, or leave chat releases the mic and ends the call.
8. LAN companion and hosted HTTPS companion both work.
9. Revoked pairing ends the call and cannot restart it.
10. Flag off: no call button.
11. Reconstructed engine chat: no call button (reference-only).

Simulator cannot prove AEC, silence endpointing quality, or speakerphone echo. Record those as device gates, not as green CI.

- [ ] **Step 3: Update `docs/voice-mode.md`**

Replace “Calls are macOS-only” and “Rooms don't speak yet” with: desktop remains the reference implementation; iOS is foreground half-duplex behind `features.iosVoiceCalls`. Keep the AEC paragraph. State Kokoro is the next Hub provider, not a renderer bundle. Note that iOS spoken approvals are whole-utterance; desktop prefix regex hardening is a follow-up. Note reconstructed chats are reference-only and not a call target.

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
- Approval yes/no safety holds; rambling speech and prefix-yes sentences re-ask; “yes!” still grants.
- Roleplay bot and a local-model bot both work through ordinary `Session.send` / SSE.
- Reconstructed chats show no call button.
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
- Calls on reconstructed engine chats (reference-only; hide the button).
- Hardening desktop `CallView.tsx` / `GroupCallView.tsx` YES/NO prefix regexes to the iOS whole-utterance parser. Ship the strict matcher on iPhone first; desktop stays unchanged in this MVP.

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
| Reuse chat / SSE / TTS | 1, 4, 6, 8 (`Session.send` / `VBotMutationRouting`) |
| Tap interrupt | 2, 6, 8 |
| Automatic silence 850ms | 5 |
| Group turn sequencing | 8 |
| Missing-sender `tool.spoken` fallback | 8 |
| Spoken approvals (whole-utterance) | 3, 7 |
| Roleplay / local models | 9 |
| Reconstructed reference-only | 2, 6, 8, 9 |
| Kokoro next (Hub, not phone) | 11 |
| Native `VBotEngineCapabilities.groups` + iOS fail-closed decode + Hermes advertisement | 9 |
| Sidecar `ttsPrepareVersion` handshake (old sidecars fail closed) | 1, 2, 6 |
| Empty visible room cannot start a team call | 2, 8, 9 |
| Locked `CallAvailability.reason` copy | 2, 6 |
| Capability negotiation / bridge placement | 2, 9, 11 |
| Tests / flags | 1, 2, 10 |
| Defer full duplex until proven AEC | 2, 12 |
| UTF-16 speak cap matching Hub `text.length` | 4 |
| Optional `voiceId` omit on prepare and speak | 4 |
| `CallAudioPlayer` `AVAudioPlayerDelegate` | 4 |
| Desktop approval-regex hardening | out of scope (named follow-up) |
| No new dependencies / no extra files in this planning commit | this document only |

### Placeholder scan

No TBD/TODO/implement-later steps. Kokoro, full duplex, and desktop YES/NO regex hardening are named follow-ups with explicit non-implementation in MVP. Task 4 HTTP/speaker tests include bodies, not comments.

### Type consistency

Locked once in Interfaces and reused:

- `CallModePolicy.reduce(phase:availability:awaitingSpokenDecision:event:)` — every test passes `availability`; full event×phase table including `captureFinal`, `captureFailed`, `speakText`, `playbackFinished`, `botBusy(false)`, `tapInterrupt`
- `CallModePolicy.availability(...)` including `canStart`
- `CallModePolicy.approvalDecision(from:)` whole-utterance, not desktop prefix regex
- `Session.send(_:to:mode:)` / `Session.interrupt(chat:)` / `Session.answer(..., message:)` — overlays never call `CompanionClient.send`
- `CallModePolicy.allowsNativeCall(mutationTarget:)` — reconstructed is reference-only
- `CompanionClient.prepareSpeech` / `synthesizeSpeech` share omit-nil/empty `voiceId`; `previewVoice` unchanged
- `CallSpeaker.assertSpeakable` uses `text.utf16.count` vs `maxSpeakUTF16CodeUnits` (500), not `String.count`
- `CallSpeaker.speak`, `stop`; `CallAudioPlaying.play` / `cancel`
- `CallAudioPlayer: NSObject, AVAudioPlayerDelegate, CallAudioPlaying`
- `CallModePolicy.transfer` / `end`
- `CallModePolicy.SpeechQueue` (`enqueue` / `next` / `interrupt`); `QueuedSpeech.botId` is `String?`; missing sender uses `unnamedSpeakerLabel` (`"Channel member"`) and nil voice
- `requiresAddress(defaultResponderKind:)`
- `allowsRoomCall(isDm:engineSupportsGroups:visibleMemberCount:)` — Task 2, Task 8, and Task 9 use the same three-argument signature; `visibleMemberCount == 0` fails
- `nativeRoomCallSupported(engineGroups:hermesGroups:visibleMemberAdvertisesHermes:)` — `== true` only; Hermes AND uses advertised `hermesBot`, not engine/instance id strings
- `companionPrepareAllowed(ttsPrepareVersion:)` — exact `1`; hub `iosVoiceCalls` is `flagged` only
- Locked `reason*` constants; `availability.reason` is first failing gate; overlays do not paraphrase
- `sendPath`, `requiredBridgeCapabilities`, `shouldSend`, `shouldTreatSpeechAsApproval`, `endpointMs`
- Task 7 does not edit `GroupCallView.swift`; Task 8 creates it and consumes CompanionCore helpers

### Supersession

Parity closeout Task 5 (“no room calls”) is superseded by Tasks 3 and 8 of this plan.
