// Per-message read-aloud for the transcript.
//
// The desktop speaks through a window-wide speaker (src/lib/tts): the
// harness splits the message into bounded utterances, one speak request per
// utterance, one audible clip at a time. The phone keeps that exact shape —
// prepare, then speak each piece in order — but the element that plays is an
// AVAudioPlayer rather than an <audio> tag, so the player lives in the app
// target; CompanionCore stays Foundation-only so `swift test` runs without a
// simulator (the same reasoning SpeechDictation records in its header).
//
// One message at a time, and the same button is stop: starting another
// message or tapping the playing one bumps a generation token, and every
// await re-checks it before it is allowed to touch the session or the
// player again. A dictation capture is stopped before any playback starts —
// the mic and a playback route must never be negotiated at the same time —
// and an audio-session interruption (a call, or the user starting dictation
// over the top) stops us the same way it stops dictation in ChatView.
import AVFoundation
import Combine
import CompanionCore

@MainActor
final class MessageSpeaker: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case preparing(messageId: String)
        case speaking(messageId: String)
    }

    @Published private(set) var phase: Phase = .idle

    /// The composer's dictation capture, paused before playback starts.
    weak var dictation: SpeechDictation?

    private var generation = 0
    private var player: AVAudioPlayer?
    /// Resumed exactly once per clip, by the delegate callback or by a stop.
    /// `false` on the stop path is always discarded by the generation check.
    private var clipContinuation: CheckedContinuation<Bool, Never>?

    private var interruptionObserver: AnyCancellable?

    override init() {
        super.init()
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

    func isPreparing(messageId: String) -> Bool {
        phase == .preparing(messageId: messageId)
    }

    func isSpeaking(messageId: String) -> Bool {
        phase == .speaking(messageId: messageId)
    }

    /// The same intent twice: speak this message, or make it be quiet.
    func toggle(message: Message, voiceId: String?, session: Session) {
        if isPreparing(messageId: message.id) || isSpeaking(messageId: message.id) {
            stop()
            return
        }
        speak(message: message, voiceId: voiceId, session: session)
    }

    func stop() {
        generation += 1
        settlePlayer()
        phase = .idle
    }

    /// The synthetic message id voice mode's phase reports under — there is
    /// no `Message` for the bot's spoken reply, just text.
    static let voiceModeMessageId = "voice-mode"

    /// Voice mode: speak arbitrary text — the bot's settled reply — and
    /// return when the last clip finishes or the run is stopped. Same
    /// prepare/speak pipeline, same one-audible-clip-at-a-time, same
    /// generation token as a message speak; `stop()` interrupts it the
    /// same way.
    func speakForVoiceMode(text: String, voiceId: String?, session: Session) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        generation += 1
        let gen = generation
        settlePlayer()
        phase = .speaking(messageId: Self.voiceModeMessageId)
        // Pause the mic before the playback route is negotiated, not after.
        dictation?.stop()
        await run(messageId: Self.voiceModeMessageId, text: trimmed, voiceId: voiceId, generation: gen, session: session)
    }

    private func speak(message: Message, voiceId: String?, session: Session) {
        let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return }
        generation += 1
        let gen = generation
        settlePlayer()
        phase = .preparing(messageId: message.id)
        // Pause the mic before the playback route is negotiated, not after.
        dictation?.stop()
        Task { @MainActor in
            await self.run(messageId: message.id, text: text, voiceId: voiceId, generation: gen, session: session)
        }
    }

    private func run(
        messageId: String,
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
                phase = .speaking(messageId: messageId)
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
        phase = .idle
    }

    private func play(_ audio: Data) async throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio)
        try audioSession.setActive(true)

        let nextPlayer = try AVAudioPlayer(data: audio)
        nextPlayer.delegate = self
        guard nextPlayer.prepareToPlay(), nextPlayer.play() else {
            throw ClipError.unplayable
        }
        player = nextPlayer
        let finished: Bool = await withCheckedContinuation { continuation in
            clipContinuation = continuation
        }
        guard finished else { throw ClipError.unplayable }
    }

    /// Stops the current clip and gives the audio route back. Safe when
    /// nothing is playing; also wakes a run suspended mid-clip so its loop
    /// can exit on the next generation check.
    private func settlePlayer() {
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
