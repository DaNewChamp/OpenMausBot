// Voice-output engine selection.
//
// Voice mode can speak through three engines: the phone's own
// AVSpeechSynthesizer (fully local, no key, works offline), the paired
// computer's prepare/speak pipeline ("hub" — the shape MessageSpeaker has
// always used), or a user-configured OpenAI-compatible speech endpoint.
// The choice is a preference stored in the same defaults the settings
// screen writes through @AppStorage; the key strings live here so the load
// that runs at speak time reads exactly what the picker writes.
//
// Foundation-only, like the rest of CompanionCore: the AVAudio engines
// themselves live in the app target (LocalTtsEngine.swift, MessageSpeaker.swift)
// so `swift test` still runs without a simulator.

import Foundation

/// Which engine speaks.
public enum VoiceOutputEngine: String, CaseIterable, Sendable {
    /// AVSpeechSynthesizer with the system voice. The voice-mode default:
    /// nothing leaves the phone, no key is needed, and it works offline.
    case onDevice
    /// The paired computer's TTS — the shared voice key and the workspace
    /// default voice live there. What the transcript's read-aloud always was.
    case hub
    /// An OpenAI-compatible `POST {base}/v1/audio/speech` endpoint the user
    /// points at: base URL, optional bearer key, model and voice name.
    case customEndpoint

    public var label: String {
        switch self {
        case .onDevice: return "On-device"
        case .hub: return "Hub voice"
        case .customEndpoint: return "Custom endpoint"
        }
    }

    public var caption: String {
        switch self {
        case .onDevice:
            return "Speaks with the system voice. Fully local — no key, works offline."
        case .hub:
            return "Speaks with the paired computer's voice. The shared key lives there."
        case .customEndpoint:
            return "Calls an OpenAI-compatible /v1/audio/speech endpoint you configure."
        }
    }
}

public struct VoiceOutputSettings: Equatable, Sendable {
    public var engine: VoiceOutputEngine
    public var customBaseURL: String
    public var customAPIKey: String
    public var customModel: String
    public var customVoice: String

    public static let customModelDefault = "tts-1"
    public static let customVoiceDefault = "alloy"

    public static let engineKey = "companion.prefs.ttsEngine"
    public static let customBaseURLKey = "companion.prefs.ttsCustomBaseURL"
    public static let customAPIKeyKey = "companion.prefs.ttsCustomAPIKey"
    public static let customModelKey = "companion.prefs.ttsCustomModel"
    public static let customVoiceKey = "companion.prefs.ttsCustomVoice"

    public init(
        engine: VoiceOutputEngine = .onDevice,
        customBaseURL: String = "",
        customAPIKey: String = "",
        customModel: String = VoiceOutputSettings.customModelDefault,
        customVoice: String = VoiceOutputSettings.customVoiceDefault
    ) {
        self.engine = engine
        self.customBaseURL = customBaseURL
        self.customAPIKey = customAPIKey
        self.customModel = customModel
        self.customVoice = customVoice
    }

    /// Read at speak time, not observed: a mid-session engine change takes
    /// effect on the next reply without any wiring.
    public static func load(defaults: UserDefaults = .standard) -> VoiceOutputSettings {
        VoiceOutputSettings(
            engine: VoiceOutputEngine(rawValue: defaults.string(forKey: engineKey) ?? "") ?? .onDevice,
            customBaseURL: defaults.string(forKey: customBaseURLKey) ?? "",
            customAPIKey: defaults.string(forKey: customAPIKeyKey) ?? "",
            customModel: nonEmpty(defaults.string(forKey: customModelKey), default: customModelDefault),
            customVoice: nonEmpty(defaults.string(forKey: customVoiceKey), default: customVoiceDefault)
        )
    }

    public func save(defaults: UserDefaults = .standard) {
        defaults.set(engine.rawValue, forKey: Self.engineKey)
        defaults.set(customBaseURL, forKey: Self.customBaseURLKey)
        defaults.set(customAPIKey, forKey: Self.customAPIKeyKey)
        defaults.set(customModel, forKey: Self.customModelKey)
        defaults.set(customVoice, forKey: Self.customVoiceKey)
    }

    /// The custom engine has enough to attempt a call.
    public var customEndpointConfigured: Bool {
        !customBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Per-bot call voice on this phone. Hub still uses server `bot.voice`.
    public func resolvedCallVoice(botId: String, serverBotVoice: String?, defaults: UserDefaults = .standard) -> String? {
        CallVoicePreferenceStore.resolvedVoice(
            botId: botId,
            engine: engine,
            serverBotVoice: serverBotVoice,
            globalCustomVoice: customVoice,
            defaults: defaults
        )
    }

    private static func nonEmpty(_ value: String?, default fallback: String) -> String {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return fallback
        }
        return value
    }
}

/// Per-bot call voice stored on this phone, namespaced by bot id.
///
/// Separate from server `bot.voice`. On-device output can pin an
/// `AVSpeechSynthesisVoice` identifier; a custom endpoint can optionally
/// override the global custom voice. Hub continues to use the server voice.
/// The custom TTS API key is never stored here.
public struct CallVoicePreference: Codable, Equatable, Sendable {
    public var onDeviceVoiceIdentifier: String
    public var customVoiceOverride: String

    public init(onDeviceVoiceIdentifier: String = "", customVoiceOverride: String = "") {
        self.onDeviceVoiceIdentifier = onDeviceVoiceIdentifier
        self.customVoiceOverride = customVoiceOverride
    }
}

public enum CallVoicePreferenceStore: Sendable {
    public static let keyPrefix = "companion.prefs.callVoice."

    public static func storageKey(botId: String) -> String? {
        let trimmed = botId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.:"))
        let cleaned = String(trimmed.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
        return keyPrefix + cleaned
    }

    public static func load(botId: String, defaults: UserDefaults = .standard) -> CallVoicePreference {
        guard let key = storageKey(botId: botId),
              let data = defaults.data(forKey: key),
              let preference = try? JSONDecoder().decode(CallVoicePreference.self, from: data)
        else {
            return CallVoicePreference()
        }
        return preference
    }

    public static func save(_ preference: CallVoicePreference, botId: String, defaults: UserDefaults = .standard) {
        guard let key = storageKey(botId: botId) else { return }
        guard let data = try? JSONEncoder().encode(preference) else { return }
        defaults.set(data, forKey: key)
    }

    public static func resolvedVoice(
        botId: String,
        engine: VoiceOutputEngine,
        serverBotVoice: String?,
        globalCustomVoice: String,
        defaults: UserDefaults = .standard
    ) -> String? {
        switch engine {
        case .hub:
            let voice = serverBotVoice?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return voice.isEmpty ? nil : voice
        case .onDevice:
            let stored = load(botId: botId, defaults: defaults).onDeviceVoiceIdentifier
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return stored.isEmpty ? nil : stored
        case .customEndpoint:
            let override = load(botId: botId, defaults: defaults).customVoiceOverride
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !override.isEmpty { return override }
            let global = globalCustomVoice.trimmingCharacters(in: .whitespacesAndNewlines)
            return global.isEmpty ? nil : global
        }
    }
}

/// Builds the request an OpenAI-compatible speech endpoint expects.
///
/// The contract is the harness's own speak call in the other direction:
/// `POST {base}/v1/audio/speech` with a JSON body of `{model, input, voice}`
/// and raw audio bytes back. Bases that already carry `/v1` or the full
/// path are taken as-is, so both `https://api.example.com` and a
/// self-hosted gateway with its own prefix work without a second setting.
public enum TtsEndpointPolicy {
    public struct SpeechRequest: Codable, Equatable, Sendable {
        public var model: String
        public var input: String
        public var voice: String

        public init(model: String, input: String, voice: String) {
            self.model = model
            self.input = input
            self.voice = voice
        }
    }

    public static func endpointURL(fromBase base: String) -> URL? {
        var trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host(percentEncoded: false) != nil
        else { return nil }
        let path = url.path.lowercased()
        if path.hasSuffix("/audio/speech") { return url }
        if path.hasSuffix("/v1") {
            return URL(string: trimmed + "/audio/speech")
        }
        return URL(string: trimmed + "/v1/audio/speech")
    }

    public static func requestBody(text: String, model: String, voice: String) -> Data {
        let request = SpeechRequest(model: model, input: text, voice: voice)
        return (try? JSONEncoder().encode(request)) ?? Data()
    }

    public static func authorizationHeader(apiKey: String) -> String? {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return nil }
        return "Bearer \(key)"
    }
}

/// Smooths a raw per-frame level into what an orb should show: fast attack
/// so speech swells immediately, slow release so the falloff reads as a
/// breath rather than a stutter. Frames land every ~20 ms from the mic tap
/// and every ~33 ms from player metering; the blend is per-frame, so the
/// defaults are tuned to those cadences.
public struct LevelFollower: Equatable, Sendable {
    /// Per-frame blend toward a louder target.
    public var attack: Float
    /// Per-frame blend toward a quieter target.
    public var release: Float
    public private(set) var value: Float = 0

    public init(attack: Float = 0.55, release: Float = 0.12) {
        self.attack = min(max(attack, 0), 1)
        self.release = min(max(release, 0), 1)
    }

    public mutating func observe(_ raw: Float) -> Float {
        let target = min(max(raw, 0), 1)
        let blend = target > value ? attack : release
        value += (target - value) * blend
        return value
    }

    public mutating func reset() {
        value = 0
    }
}

/// Turns discrete speech events into a level: each event bumps toward a
/// peak, and the value decays exponentially until the next one. The
/// on-device synthesizer reports per word-range, not per sample, so this
/// is what makes the orb pulse syllable-ish between callbacks.
public struct AmplitudeEnvelope: Equatable, Sendable {
    /// Time for the level to halve with no new bump.
    public var halfLife: TimeInterval
    public private(set) var peak: Float = 0
    private var anchoredAt: Date?

    public init(halfLife: TimeInterval = 0.09) {
        self.halfLife = halfLife
    }

    public mutating func bump(to newPeak: Float, at now: Date = Date()) {
        peak = min(max(newPeak, 0), 1)
        anchoredAt = now
    }

    public mutating func decayed(at now: Date = Date()) -> Float {
        guard let anchoredAt else { return 0 }
        let elapsed = now.timeIntervalSince(anchoredAt)
        guard elapsed >= 0 else { return peak }
        let value = peak * Float(pow(0.5, elapsed / halfLife))
        return value < 0.02 ? 0 : value
    }

    public mutating func reset() {
        peak = 0
        anchoredAt = nil
    }
}
