// Voice output for the phone.
//
// The desktop speaks through a window-wide speaker (src/lib/tts): the
// harness splits the message into bounded utterances, one speak request per
// utterance, one audible clip at a time. The phone keeps that exact shape —
// prepare, then speak each piece in order — but the element that plays is an
// AVAudioPlayer rather than an <audio> tag, so the player lives in the app
// target; CompanionCore stays Foundation-only so `swift test` runs without a
// simulator (the same reasoning SpeechDictation records in its header).
//
// Three engines sit behind one surface, picked per run from
// VoiceOutputSettings: "hub" is that prepare/speak pipeline with the shared
// voice key; "on-device" is LocalTtsEngine (AVSpeechSynthesizer); "custom
// endpoint" fetches audio from an OpenAI-compatible speech server and plays
// it here. Whichever engine speaks, the rules are the same: one audible
// clip at a time, generation-token single-speaker semantics, a dictation
// capture stopped before any playback route is negotiated, and an
// audio-session interruption stops us the same way it stops dictation in
// ChatView.
//
// `onAmplitude` publishes rough output level (player metering, or the
// synthesizer's word envelope) so voice mode's orb moves with the real
// voice.
import AVFoundation
import Combine
import CompanionCore

@MainActor
final class MessageSpeaker: NSObject, ObservableObject {
    /// Live output amplitude 0...1 while a clip plays, for the orb.
    var onAmplitude: ((Float) -> Void)?

    /// The composer's dictation capture, paused before playback starts.
    weak var dictation: SpeechDictation?

    private var generation = 0
    private var player: AVAudioPlayer?
    /// Resumed exactly once per clip, by the delegate callback or by a stop.
    /// `false` on the stop path is always discarded by the generation check.
    private var clipContinuation: CheckedContinuation<Bool, Never>?
    private var meterTimer: Timer?
    private let localEngine = LocalTtsEngine()
    private let customClient = CustomEndpointTtsClient()

    private var interruptionObserver: AnyCancellable?

    override init() {
        super.init()
        localEngine.onAmplitude = { [weak self] level in
            self?.onAmplitude?(level)
        }
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

    func stop() {
        generation += 1
        settlePlayer()
    }

    /// Voice mode: speak arbitrary text — the bot's settled reply — with
    /// the configured engine, and return when the last clip finishes or the
    /// run is stopped. One audible clip at a time, one generation token;
    /// `stop()` interrupts it the same way.
    func speakForVoiceMode(text: String, voiceId: String?, session: Session) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        generation += 1
        let gen = generation
        settlePlayer()
        // Pause the mic before the playback route is negotiated, not after.
        dictation?.stop()
        let settings = VoiceOutputSettings.load()
        var failure: String?
        switch settings.engine {
        case .hub:
            await run(text: trimmed, voiceId: voiceId, generation: gen, session: session)
            return
        case .onDevice:
            do {
                try await localEngine.speak(text: trimmed)
            } catch {
                // A deliberate stop also lands here, discarded by the
                // generation check below.
                failure = "On-device speech could not play."
            }
        case .customEndpoint:
            do {
                let audio = try await customClient.fetchAudio(text: trimmed, settings: settings)
                guard gen == generation else { return }
                try await play(audio)
            } catch {
                guard gen == generation else { return }
                failure = settings.customEndpointConfigured
                    ? "The custom voice endpoint could not be reached."
                    : "Add a base URL for the custom voice endpoint in Settings → Chat."
            }
        }
        guard gen == generation else { return }
        if let failure {
            session.actionError = failure
        }
        finish(generation: gen)
    }

    /// Stream-and-speak, on-device only: the sentences of a reply that is
    /// still streaming arrive through `chunks` and are queued for speech
    /// as they come, so the bot starts talking before the text is all
    /// here. Returns when the queue has drained (true) or the stream was
    /// stopped (false — a barge-in, a close, an interruption, an engine
    /// that could not start); the caller's phase check decides what the
    /// loop does next, exactly as `speakForVoiceMode` does.
    func speakStream(chunks: AsyncStream<String>, session: Session) async -> Bool {
        // Pause the mic before the playback route is negotiated, not after.
        dictation?.stop()
        let generation: Int
        do {
            generation = try localEngine.startStream()
        } catch {
            session.actionError = "On-device speech could not play."
            return false
        }
        for await chunk in chunks {
            guard localEngine.streamIsActive(generation) else { return false }
            localEngine.enqueue(chunk, generation: generation)
        }
        guard localEngine.streamIsActive(generation) else { return false }
        localEngine.finishStream(generation: generation)
        return await localEngine.waitUntilDrained(generation: generation)
    }

    private func run(
        text: String,
        voiceId: String?,
        generation gen: Int,
        session: Session
    ) async {
        guard let preparation = await session.prepareSpeech(text: text, voiceId: voiceId) else {
            // The transport failure is already on screen; this run is over.
            finish(generation: gen)
            return
        }
        guard gen == generation else { return }
        switch MessageSpeechPolicy.plan(preparation: preparation, text: text) {
        case .notReady:
            session.actionError = MessageSpeechPolicy.notReadyMessage
            finish(generation: gen)
        case let .speak(utterances):
            for utterance in utterances {
                guard gen == generation else { return }
                guard let audio = await session.speakUtterance(utterance, voiceId: voiceId) else {
                    finish(generation: gen)
                    return
                }
                guard gen == generation else { return }
                do {
                    try await play(audio)
                } catch {
                    // A deliberate stop also lands here, as a discarded
                    // clip result; only a still-current run reports it.
                    guard gen == generation else { return }
                    session.actionError = "The generated voice clip could not be played."
                    finish(generation: gen)
                    return
                }
            }
            finish(generation: gen)
        }
    }

    private func finish(generation gen: Int) {
        guard gen == generation else { return }
        settlePlayer()
    }

    private func play(_ audio: Data) async throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio)
        try audioSession.setActive(true)

        let nextPlayer = try AVAudioPlayer(data: audio)
        nextPlayer.delegate = self
        nextPlayer.isMeteringEnabled = true
        guard nextPlayer.prepareToPlay(), nextPlayer.play() else {
            throw ClipError.unplayable
        }
        player = nextPlayer
        startMetering(nextPlayer)
        let finished: Bool = await withCheckedContinuation { continuation in
            clipContinuation = continuation
        }
        guard finished else { throw ClipError.unplayable }
    }

    /// The clip's real loudness, ~30 reads a second while it plays: the orb
    /// swells with the voice instead of a stand-in animation.
    private func startMetering(_ player: AVAudioPlayer) {
        meterTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let player = self.player else { return }
                player.updateMeters()
                self.onAmplitude?(Self.level(fromDecibels: player.averagePower(forChannel: 0)))
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        meterTimer = timer
    }

    private func stopMetering() {
        meterTimer?.invalidate()
        meterTimer = nil
        onAmplitude?(0)
    }

    /// Player metering reads decibels; the orb wants 0...1. Speech sits
    /// roughly between -46 dB (room floor) and -4 dB (close and loud).
    static func level(fromDecibels decibels: Float) -> Float {
        min(max((decibels + 46) / 42, 0), 1)
    }

    /// Stops the current clip and gives the audio route back. Safe when
    /// nothing is playing; also wakes a run suspended mid-clip so its loop
    /// can exit on the next generation check.
    private func settlePlayer() {
        localEngine.stop()
        stopMetering()
        player?.stop()
        player = nil
        clipContinuation?.resume(returning: false)
        clipContinuation = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private enum ClipError: Error {
        case unplayable
    }
}

extension MessageSpeaker: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard let continuation = self.clipContinuation else { return }
            self.clipContinuation = nil
            continuation.resume(returning: flag)
        }
    }
}
