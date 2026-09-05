// Live voice mode, the half that has no microphone and no audio.
//
// The loop is half-duplex, like a walkie-talkie: listen, send, wait for the
// reply to settle, speak it, listen again. The AVAudio machinery — the
// Speech capture, the TTS player, the audio session juggling — lives in the
// app target for the same reason SpeechDictation and MessageSpeaker record
// in their headers: CompanionCore is Foundation-only so `swift test` runs
// without a simulator. What lives here is the state machine those pieces
// step through, so the loop itself is decided in one testable place.
//
// Approvals are deliberately absent from this machine: a pending card does
// not move the loop, it *ends* it. The controller tears the session down and
// hands the screen back, because a needs-you card outranks a conversation.
import Foundation

public enum VoiceSessionPhase: Equatable, Sendable {
    case idle
    case listening
    case thinking
    case speaking
}

public enum VoiceSessionEvent: Equatable, Sendable {
    /// The call opened. From idle this starts listening without an orb tap.
    case opened
    /// The orb was tapped from idle and the microphone is wanted.
    case micReady
    /// Capture ended — by tap or by silence. `hasTranscript` says whether
    /// anything was heard.
    case micStopped(hasTranscript: Bool)
    /// The send round-trip failed, or a stream-and-speak engine could not
    /// start or died mid-turn. The error is already on screen.
    case sendFailed
    /// The reply finished streaming. `shouldSpeak` is false when muted;
    /// `hasReply` is false when the run settled with nothing speakable.
    case replySettled(hasReply: Bool, shouldSpeak: Bool)
    /// The generated voice finished playing, or the streamed utterance
    /// queue drained — either way the speaking turn is over.
    case replySpoken
    /// Stream-and-speak: the first sentence of a still-streaming reply is
    /// ready, so speaking starts before the run has settled.
    case streamStarted
    /// The orb was tapped mid-turn: stop the run or the clip, go back to
    /// listening.
    case bargeIn
    /// The user closed voice mode (or the system took the screen). Valid
    /// from every phase.
    case closed
}

public enum VoiceSessionDecision: Equatable, Sendable {
    /// The event means nothing in this phase.
    case stay
    /// Start (or resume) the microphone.
    case listen
    /// Sit at the dim orb, waiting for a tap.
    case idle
    /// Stop the microphone and send what was heard.
    case sendTranscript
    /// Speak the settled reply.
    case speakReply
    /// Speak a reply that is still streaming, sentence by sentence; the
    /// turn ends when the stream closes and the utterance queue drains.
    case speakStreamReply
    /// Tear everything down: mic, player, watchers, island.
    case stopAll
}

public enum VoiceSessionPolicy: Sendable {
    /// Silence that outlasts this ends a listening turn. Short enough that
    /// the turn feels voice-driven, long enough for a breath between
    /// clauses.
    public static let silenceLimit: TimeInterval = 2.5
    /// A run that never settles cannot hold voice mode hostage forever.
    public static let replyTimeout: TimeInterval = 90

    public static func decide(phase: VoiceSessionPhase, event: VoiceSessionEvent) -> VoiceSessionDecision {
        switch event {
        case .closed:
            return .stopAll
        case .opened, .micReady:
            guard phase == .idle else { return .stay }
            return .listen
        case .micStopped(let hasTranscript):
            guard phase == .listening else { return .stay }
            return hasTranscript ? .sendTranscript : .idle
        case .sendFailed:
            // A failed send sits in .thinking; a stream-and-speak engine
            // that died mid-turn sits in .speaking. Both are dead turns.
            guard phase == .thinking || phase == .speaking else { return .stay }
            return .idle
        case .replySettled(let hasReply, let shouldSpeak):
            guard phase == .thinking else { return .stay }
            return hasReply && shouldSpeak ? .speakReply : .listen
        case .replySpoken:
            guard phase == .speaking else { return .stay }
            return .listen
        case .streamStarted:
            guard phase == .thinking else { return .stay }
            return .speakStreamReply
        case .bargeIn:
            switch phase {
            case .thinking, .speaking:
                return .listen
            case .idle, .listening:
                return .stay
            }
        }
    }

    /// RMS at or above this counts as voice for the silence gate. Rooms idle
    /// well under it; speech at hand-held distance sits well over it.
    public static let voiceThreshold: Float = 0.012

    /// Linear RMS of a sample buffer. The app-target tap uses the same
    /// formula in place; this copy is what the tests pin.
    public static func rms(of samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in samples {
            sum += sample * sample
        }
        return sqrt(sum / Float(samples.count))
    }

    /// Int16 PCM scaled onto [-1, 1] then RMS. Some input routes deliver
    /// integer samples; treating those as missing float data made the orb
    /// sit at zero while speech still transcribed.
    public static func rms(ofInt16 samples: [Int16]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        let scale: Float = 1 / 32768
        for sample in samples {
            let value = Float(sample) * scale
            sum += value * value
        }
        return sqrt(sum / Float(samples.count))
    }

    /// Maps linear RMS onto 0...1 for the orb. Hand-held speech sits roughly
    /// -40 to -12 dBFS; below `floor` is silence, above `ceiling` is full.
    public static func normalizedMicLevel(rms: Float) -> Float {
        let floor: Float = -50
        let ceiling: Float = -8
        let safe = max(rms, 1e-8)
        let db = 20 * log10(safe)
        return min(max((db - floor) / (ceiling - floor), 0), 1)
    }

    /// Island copy for the voice session — "Listening…" and friends, one
    /// place so the orb caption and the Dynamic Island cannot drift.
    public static func islandLine(for phase: VoiceSessionPhase) -> String {
        switch phase {
        case .idle: return "Tap the orb to talk"
        case .listening: return "Listening…"
        case .thinking: return "Thinking…"
        case .speaking: return "Speaking…"
        }
    }

    public static func islandHeadline(name: String, phase: VoiceSessionPhase) -> String {
        switch phase {
        case .idle: return "\(name) — live voice"
        case .listening: return "\(name) is listening"
        case .thinking: return "\(name) is thinking"
        case .speaking: return "\(name) is speaking"
        }
    }

    /// Call-screen status: phone-call words, not island copy. Mic mute
    /// replaces the waiting states; thinking and speaking still name the bot.
    public static func callStatusLine(for phase: VoiceSessionPhase, micMuted: Bool) -> String {
        if micMuted {
            switch phase {
            case .idle, .listening: return "Muted"
            case .thinking: return "Thinking"
            case .speaking: return "Speaking"
            }
        }
        switch phase {
        case .idle: return "Tap to talk"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }

    /// Time in call — m:ss, or h:mm:ss past the hour.
    public static func callDurationLabel(elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed))
        let hours = total / 3600
        let minutes = total / 60 % 60
        let seconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }

    /// Team-call speech for one room turn. Only messages that appeared after
    /// the send are spoken, in transcript order, and each agent names itself
    /// so multiple replies are intelligible over audio.
    public static func teamReplyText(messages: [Message], excluding existingIds: Set<String>) -> String {
        messages
            .filter { $0.role == .bot && $0.kind == .text && !existingIds.contains($0.id) }
            .compactMap { message -> String? in
                guard let raw = message.text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
                let speaker = message.from?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return speaker.isEmpty ? raw : "\(speaker): \(raw)"
            }
            .joined(separator: "\n\n")
    }
}

/// Audio and background rules for a user-started agent call.
///
/// The session stays `playAndRecord` + `voiceChat` for the whole call so
/// Bluetooth HFP and speakerphone keep working and an `audio` background
/// mode can hold the process while the user is in the call. Capture and
/// playback still never run together. This does not claim the call survives
/// app termination — only backgrounding.
public enum VoiceCallAudioPolicy: Sendable {
    public static let category = "playAndRecord"
    public static let mode = "voiceChat"
    public static let defaultToSpeaker = true
    public static let allowBluetooth = true
    public static let allowsSimultaneousCaptureAndPlayback = false
    public static let continuesAfterAppTermination = false

    public static func shouldKeepAudioSessionActive(
        isCallActive: Bool,
        phase: VoiceSessionPhase
    ) -> Bool {
        _ = phase
        return isCallActive
    }

    public static func shouldDeactivateAudioSession(isCallActive: Bool) -> Bool {
        !isCallActive
    }

    public static func shouldSuspendCaptureOnBackground(isCallActive: Bool) -> Bool {
        !isCallActive
    }

    public static func shouldKeepEventStreamInBackground(isCallActive: Bool) -> Bool {
        isCallActive
    }
}

/// Outgoing CallKit bookkeeping. No incoming call, no PushKit.
///
/// One UUID per agent call. System End Call closes the V Bot session;
/// an in-app hang-up requests CXEndCallAction exactly once. Mute is
/// mirrored in both directions without re-requesting the same value.
public struct AgentCallKitState: Equatable, Sendable {
    public var uuid: UUID?
    public var isReported: Bool
    public var isMuted: Bool
    public var isEnding: Bool

    public static let empty = AgentCallKitState(
        uuid: nil,
        isReported: false,
        isMuted: false,
        isEnding: false
    )

    public init(uuid: UUID? = nil, isReported: Bool = false, isMuted: Bool = false, isEnding: Bool = false) {
        self.uuid = uuid
        self.isReported = isReported
        self.isMuted = isMuted
        self.isEnding = isEnding
    }
}

public enum AgentCallKitEvent: Equatable, Sendable {
    case userStarted(handle: String)
    case providerStarted
    case userEnded
    case systemEnded
    case providerReset
    case userSetMuted(Bool)
    case systemSetMuted(Bool)
}

public enum AgentCallKitAction: Equatable, Sendable {
    case requestStartOutgoing(uuid: UUID, handle: String)
    case requestEnd(uuid: UUID)
    case requestMute(uuid: UUID, muted: Bool)
    case closeVoiceSession
    case applyMuted(Bool)
}

public enum AgentCallKitPolicy: Sendable {
    public static func reduce(
        state: AgentCallKitState,
        event: AgentCallKitEvent,
        newUUID: UUID = UUID()
    ) -> (AgentCallKitState, [AgentCallKitAction]) {
        switch event {
        case .userStarted(let handle):
            if state.uuid != nil { return (state, []) }
            let next = AgentCallKitState(uuid: newUUID, isReported: false, isMuted: false, isEnding: false)
            return (next, [.requestStartOutgoing(uuid: newUUID, handle: handle)])
        case .providerStarted:
            guard state.uuid != nil, !state.isEnding else { return (state, []) }
            var next = state
            next.isReported = true
            var actions: [AgentCallKitAction] = []
            if next.isMuted, let uuid = next.uuid {
                actions.append(.requestMute(uuid: uuid, muted: true))
            }
            return (next, actions)
        case .userEnded:
            guard let uuid = state.uuid, !state.isEnding else { return (state, []) }
            var next = state
            next.isEnding = true
            return (next, [.requestEnd(uuid: uuid)])
        case .systemEnded:
            guard state.uuid != nil else { return (.empty, []) }
            if state.isEnding {
                return (.empty, [])
            }
            return (.empty, [.closeVoiceSession])
        case .providerReset:
            guard state.uuid != nil else { return (.empty, []) }
            return (.empty, [.closeVoiceSession])
        case .userSetMuted(let muted):
            guard state.uuid != nil, state.isMuted != muted else { return (state, []) }
            var next = state
            next.isMuted = muted
            var actions: [AgentCallKitAction] = [.applyMuted(muted)]
            if let uuid = state.uuid, state.isReported {
                actions.append(.requestMute(uuid: uuid, muted: muted))
            }
            return (next, actions)
        case .systemSetMuted(let muted):
            guard state.uuid != nil, state.isMuted != muted else { return (state, []) }
            var next = state
            next.isMuted = muted
            return (next, [.applyMuted(muted)])
        }
    }
}

/// Silence endpointing for a listening turn, decided from mic levels alone.
///
/// The recognizer's partials lag real speech by enough that waiting for an
/// empty transcript would either send early or never send. Levels are
/// instant: any frame at or above `voiceThreshold` is voice, and it re-arms
/// the window; the turn finalizes when the window — from session start, or
/// from the last voiced frame — runs out.
public struct VoiceSilenceGate: Equatable, Sendable {
    public var limit: TimeInterval
    public var voiceThreshold: Float
    public private(set) var heardVoice: Bool
    private var anchor: Date

    public init(limit: TimeInterval = VoiceSessionPolicy.silenceLimit, voiceThreshold: Float = VoiceSessionPolicy.voiceThreshold, now: Date = Date()) {
        self.limit = limit
        self.voiceThreshold = voiceThreshold
        self.heardVoice = false
        self.anchor = now
    }

    /// Feed one mic frame. Returns true exactly once per turn, when the
    /// silence window has expired.
    public mutating func observe(level: Float, at now: Date = Date()) -> Bool {
        if level >= voiceThreshold {
            heardVoice = true
            anchor = now
            return false
        }
        return now.timeIntervalSince(anchor) >= limit
    }
}

/// Stream-and-speak bookkeeping for one spoken reply: a generation token
/// shared by every utterance of the reply, the count of utterances queued
/// or still speaking, and the drain rule — the speaking turn is over only
/// when the text stream has finished AND the queue is empty.
///
/// Stopping bumps the generation, so a sentence enqueued around a barge-in
/// carries a stale token and is dropped instead of spoken.
public struct VoiceUtteranceQueue: Equatable, Sendable {
    public private(set) var generation: Int
    /// Utterances queued for speech or still being spoken.
    public private(set) var pending: Int
    public private(set) var streamFinished: Bool

    public init(generation: Int = 0) {
        self.generation = generation
        self.pending = 0
        self.streamFinished = false
    }

    /// Only the utterances of the current generation may speak.
    public func isActive(_ generation: Int) -> Bool { generation == self.generation }

    /// The speaking turn is over: nothing is queued and no more is coming.
    public var isDrained: Bool { streamFinished && pending == 0 }

    public mutating func enqueue() { pending += 1 }

    /// One utterance finished or was cancelled — it is off the queue
    /// either way.
    public mutating func utteranceFinished() { pending = max(pending - 1, 0) }

    /// The text stream has delivered everything; the rest is playback.
    public mutating func finishStream() { streamFinished = true }

    /// A barge-in, a close, an interruption: everything queued is dropped
    /// and the next stream speaks under a fresh token.
    public mutating func stop() {
        generation += 1
        pending = 0
        streamFinished = false
    }
}
