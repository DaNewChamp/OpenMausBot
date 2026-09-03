// The on-device and custom-endpoint voice engines.
//
// LocalTtsEngine speaks with AVSpeechSynthesizer and the system voice —
// fully local, no key, works offline, no content filtering. It keeps
// MessageSpeaker's surface: `speak` returns when the clip finishes (or
// throws when it was stopped or failed), `stop` interrupts, an audio-session
// interruption stops it the same way the player path is stopped, and the
// playback route (.playback / .spokenAudio) is negotiated only while
// speaking — the caller has already paused dictation by then, which is the
// existing rule that the mic and a playback route are never negotiated
// together.
//
// The synthesizer reports per word-range, not per sample, so the orb's
// amplitude comes from AmplitudeEnvelope: each willSpeakRange bumps toward
// a peak and a small timer lets it decay between words, which reads as
// syllables. (willSpeakRangeOfSpeechString is the closest thing the
// on-device path has to metering — there is no audio buffer to tap.)
//
// CustomEndpointTtsClient is the fetch half of the custom engine: a POST to
// `{base}/v1/audio/speech` with `{model, input, voice}` and audio bytes
// back — the same contract as the hub's speak call, pointed somewhere else.
// Playback and metering stay in MessageSpeaker.
//
// Lives in the app target on purpose; CompanionCore is Foundation-only so
// `swift test` runs without a simulator.
import AVFoundation
import Combine
import CompanionCore
import os

@MainActor
final class LocalTtsEngine: NSObject {
    enum EngineError: Error {
        case unplayable
    }

    /// Rough output amplitude 0...1 while speaking, for the orb.
    var onAmplitude: ((Float) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    /// Resumed exactly once per clip, by the delegate callback or by a
    /// stop — the same shape as MessageSpeaker's clip continuation.
    private var clipContinuation: CheckedContinuation<Bool, Never>?
    private var envelope = AmplitudeEnvelope()
    private var pulseTimer: Timer?
    private var interruptionObserver: AnyCancellable?

    private static let log = Logger(subsystem: "com.posival.openmausmobile", category: "local-tts")

    override init() {
        super.init()
        synthesizer.delegate = self
        interruptionObserver = NotificationCenter.default
            .publisher(for: AVAudioSession.interruptionNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
                let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt) ?? 0
                if value == AVAudioSession.InterruptionType.began.rawValue {
                    self?.stop()
                }
            }
    }

    /// Speaks the whole text and returns when it finishes. Throws when the
    /// clip was stopped (a barge-in, a close, an interruption) or could not
    /// play; the caller's generation check decides whether anyone still
    /// cares, exactly as the player path does.
    func speak(text: String) async throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio)
        try audioSession.setActive(true)

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)

        envelope = AmplitudeEnvelope()
        startPulse()
        let finished: Bool = await withCheckedContinuation { continuation in
            self.clipContinuation = continuation
            self.synthesizer.speak(utterance)
        }
        stopPulse()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard finished else { throw EngineError.unplayable }
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        resumeClip(finished: false)
        stopPulse()
    }

    private func resumeClip(finished: Bool) {
        guard let continuation = clipContinuation else { return }
        clipContinuation = nil
        continuation.resume(returning: finished)
    }

    private func startPulse() {
        pulseTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.onAmplitude?(self.envelope.decayed())
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        pulseTimer = timer
    }

    private func stopPulse() {
        pulseTimer?.invalidate()
        pulseTimer = nil
        onAmplitude?(0)
    }
}

extension LocalTtsEngine: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            // Longer ranges spread the same energy over more time — peak
            // lower so a run of long words does not hold the orb wide open.
            let peak: Float = characterRange.length <= 3 ? 0.9 : (characterRange.length <= 7 ? 0.75 : 0.6)
            self.envelope.bump(to: peak)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.resumeClip(finished: true) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.resumeClip(finished: false) }
    }
}

/// Fetches audio bytes from a user-configured OpenAI-compatible speech
/// endpoint. Any failure — bad base URL, non-200, empty body — is thrown to
/// the caller, which puts one line on screen.
struct CustomEndpointTtsClient {
    enum FetchError: Error {
        case notConfigured
        case badResponse(status: Int)
        case emptyBody
    }

    func fetchAudio(text: String, settings: VoiceOutputSettings) async throws -> Data {
        guard settings.customEndpointConfigured,
              let url = TtsEndpointPolicy.endpointURL(fromBase: settings.customBaseURL)
        else { throw FetchError.notConfigured }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authorization = TtsEndpointPolicy.authorizationHeader(apiKey: settings.customAPIKey) {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        request.httpBody = TtsEndpointPolicy.requestBody(text: text, model: settings.customModel, voice: settings.customVoice)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw FetchError.badResponse(status: status)
        }
        guard !data.isEmpty else { throw FetchError.emptyBody }
        return data
    }
}
