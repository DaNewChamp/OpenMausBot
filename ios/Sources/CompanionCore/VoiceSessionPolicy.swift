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
    /// The orb was tapped from idle and the microphone is wanted.
    case micReady
    /// Capture ended — by tap or by silence. `hasTranscript` says whether
    /// anything was heard.
    case micStopped(hasTranscript: Bool)
    /// The send round-trip failed. The transport error is already on screen.
    case sendFailed
    /// The reply finished streaming. `shouldSpeak` is false when muted;
    /// `hasReply` is false when the run settled with nothing speakable.
    case replySettled(hasReply: Bool, shouldSpeak: Bool)
    /// The generated voice finished playing.
    case replySpoken
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
        case .micReady:
            guard phase == .idle else { return .stay }
            return .listen
        case .micStopped(let hasTranscript):
            guard phase == .listening else { return .stay }
            return hasTranscript ? .sendTranscript : .idle
        case .sendFailed:
            guard phase == .thinking else { return .stay }
            return .idle
        case .replySettled(let hasReply, let shouldSpeak):
            guard phase == .thinking else { return .stay }
            return hasReply && shouldSpeak ? .speakReply : .listen
        case .replySpoken:
            guard phase == .speaking else { return .stay }
            return .listen
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
