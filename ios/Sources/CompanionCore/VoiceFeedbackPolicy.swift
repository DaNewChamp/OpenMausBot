// Presentation and feedback policy for live voice mode and calls.
//
// Governs haptics, cues, orb visual state, amplitude mapping, and voice
// picker prioritization. CompanionCore is Foundation-only so this policy
// is directly testable without an iOS simulator.
import Foundation

public enum VoiceFeedbackPolicy: Sendable {

    // MARK: - 1. Sound & Haptic Feedback Policy

    /// Sound cues are off by default.
    public static let defaultSoundsEnabled: Bool = false

    /// Determines if a haptic should occur on entering a new voice phase.
    /// Haptics are restrained, only played in the foreground, and NEVER
    /// when the microphone is listening or the session is disconnected.
    public static func shouldPlayHaptic(
        phase: VoiceSessionPhase,
        isForeground: Bool,
        isMuted: Bool,
        isDisconnected: Bool
    ) -> Bool {
        guard isForeground, !isDisconnected else { return false }
        switch phase {
        case .listening:
            // Microphone listening must NEVER buzz or vibrate into the audio stream
            return false
        case .idle:
            return false
        case .thinking, .speaking:
            return true
        }
    }

    /// Intensity for restrained haptic feedback.
    public static func hapticIntensity(for phase: VoiceSessionPhase) -> Float {
        switch phase {
        case .thinking:
            return 0.40
        case .speaking:
            return 0.65
        case .listening, .idle:
            return 0.0
        }
    }

    /// Determines if a phase tone cue should play.
    /// Undocumented system-sound chirps (1113, 1114, 1104) are completely removed.
    /// Listening phase must NEVER play a sound cue that bleeds into the mic.
    public static func shouldPlayTone(
        phase: VoiceSessionPhase,
        soundsEnabled: Bool
    ) -> Bool {
        guard soundsEnabled else { return false }
        switch phase {
        case .listening:
            return false
        case .idle, .thinking, .speaking:
            // No intrusive sound cues during call phases
            return false
        }
    }

    // MARK: - 2. Premium Voice Orb Presentation Policy

    public enum OrbVisualState: Equatable, Sendable {
        case idle
        case listening
        case thinking
        case speaking
        case muted
        case reconnecting
    }

    /// Resolves the visual state of the orb.
    /// Reconnecting and muted have distinct, non-listening looks.
    public static func orbVisualState(
        phase: VoiceSessionPhase,
        isMuted: Bool,
        isDisconnected: Bool
    ) -> OrbVisualState {
        if isDisconnected {
            return .reconnecting
        }
        if isMuted && (phase == .listening || phase == .idle) {
            return .muted
        }
        switch phase {
        case .idle:
            return .idle
        case .listening:
            return .listening
        case .thinking:
            return .thinking
        case .speaking:
            return .speaking
        }
    }

    /// Calculates effective amplitude.
    /// Listening uses actual mic amplitude, speaking uses actual playback amplitude.
    /// No fake amplitude in muted, offline, idle, or thinking.
    public static func effectiveAmplitude(
        phase: VoiceSessionPhase,
        micLevel: Float,
        voiceLevel: Float,
        isMuted: Bool,
        isDisconnected: Bool
    ) -> Float {
        if isDisconnected || (isMuted && phase != .speaking) {
            return 0.0
        }
        switch phase {
        case .idle, .thinking:
            return 0.0
        case .listening:
            return max(0.0, min(1.0, micLevel))
        case .speaking:
            return max(0.0, min(1.0, voiceLevel))
        }
    }

    /// Whether continuous animations (scaling, breathing, orbit) are allowed.
    /// Reduce Motion must stop continuous scale/orbit; background must stop animation.
    public static func allowsContinuousMotion(
        reduceMotion: Bool,
        isBackground: Bool
    ) -> Bool {
        !reduceMotion && !isBackground
    }

    /// Scaled core size based on phase, amplitude, reduceMotion, and background.
    public static func coreScale(
        phase: VoiceSessionPhase,
        amplitude: Float,
        reduceMotion: Bool,
        isBackground: Bool,
        breatheOffset: Float = 0.0
    ) -> Float {
        guard allowsContinuousMotion(reduceMotion: reduceMotion, isBackground: isBackground) else {
            return 1.0
        }
        switch phase {
        case .idle:
            return 1.0 + breatheOffset * 0.02
        case .listening:
            return 1.0 + amplitude * 0.35 + breatheOffset * 0.02
        case .thinking:
            return 1.0
        case .speaking:
            return 1.0 + amplitude * 0.30
        }
    }

    // MARK: - 3. Call Voice Catalog & Selection Policy

    public enum VoiceSource: Equatable, Sendable {
        case iPhone
        case hub
        case custom
    }

    public struct VoiceChoice: Identifiable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var language: String

        public init(id: String, name: String, language: String) {
            self.id = id
            self.name = name
            self.language = language
        }
    }

    public struct VoicePickerItem: Identifiable, Hashable, Sendable {
        public var id: String
        public var label: String
        public var language: String
        public var isPreserved: Bool
        public var source: VoiceSource

        public init(
            id: String,
            label: String,
            language: String = "",
            isPreserved: Bool = false,
            source: VoiceSource = .iPhone
        ) {
            self.id = id
            self.label = label
            self.language = language
            self.isPreserved = isPreserved
            self.source = source
        }
    }

    /// Prioritizes available on-device voices:
    /// 1. System default
    /// 2. Preserved previous selection if voice vanished
    /// 3. Current active voice selection
    /// 4. Voices in current device language
    /// 5. Remaining voices
    public static func prioritizeVoices(
        available: [VoiceChoice],
        currentVoiceId: String,
        currentLanguageCode: String
    ) -> [VoicePickerItem] {
        var items: [VoicePickerItem] = []

        // System default always first
        items.append(VoicePickerItem(id: "", label: "System default", language: "", isPreserved: false, source: .iPhone))

        let trimmedSelection = currentVoiceId.trimmingCharacters(in: .whitespacesAndNewlines)

        // If existing selection is not empty and not found in available voices, preserve it
        let foundInAvailable = available.contains { $0.id == trimmedSelection }
        if !trimmedSelection.isEmpty && !foundInAvailable {
            items.append(
                VoicePickerItem(
                    id: trimmedSelection,
                    label: "\(trimmedSelection) · Preserved selection",
                    language: "",
                    isPreserved: true,
                    source: .iPhone
                )
            )
        }

        let langPrefix = currentLanguageCode.replacingOccurrences(of: "_", with: "-").lowercased().split(separator: "-").first.map(String.init) ?? currentLanguageCode.lowercased()

        // Separate into current language vs others
        let currentLangVoices = available.filter { voice in
            let code = voice.language.lowercased()
            return code.hasPrefix(langPrefix)
        }
        let otherVoices = available.filter { voice in
            let code = voice.language.lowercased()
            return !code.hasPrefix(langPrefix)
        }

        // Put current selected voice right at the top of current language if present
        var sortedCurrentLang = currentLangVoices
        if let currentIdx = sortedCurrentLang.firstIndex(where: { $0.id == trimmedSelection }) {
            let currentItem = sortedCurrentLang.remove(at: currentIdx)
            sortedCurrentLang.insert(currentItem, at: 0)
        }

        for voice in sortedCurrentLang {
            items.append(
                VoicePickerItem(
                    id: voice.id,
                    label: voice.name,
                    language: voice.language,
                    isPreserved: false,
                    source: .iPhone
                )
            )
        }

        for voice in otherVoices {
            // Also prioritize current voice if it happened to be in otherVoices
            if voice.id == trimmedSelection && !sortedCurrentLang.contains(where: { $0.id == trimmedSelection }) {
                items.insert(
                    VoicePickerItem(
                        id: voice.id,
                        label: voice.name,
                        language: voice.language,
                        isPreserved: false,
                        source: .iPhone
                    ),
                    at: items.count > 1 ? 1 : items.count
                )
            } else {
                items.append(
                    VoicePickerItem(
                        id: voice.id,
                        label: voice.name,
                        language: voice.language,
                        isPreserved: false,
                        source: .iPhone
                    )
                )
            }
        }

        return items
    }

    /// Voice preview is only allowed when there is NO active call.
    public static func isVoicePreviewAllowed(hasActiveCall: Bool) -> Bool {
        !hasActiveCall
    }

    public static func previewDisabledReason(hasActiveCall: Bool) -> String {
        hasActiveCall ? "Voice preview is unavailable during an active call to prevent audio interruption." : ""
    }
}
