// The live voice loop, driving the policy.
//
// VoiceSessionPolicy (CompanionCore) decides; this owns the pieces it
// decides between: the SpeechDictation capture, the MessageSpeaker voice
// pipeline, the send path ChatView uses, and the reply watcher that notices
// when a run has settled. Half-duplex on purpose — mic and playback route
// are never negotiated together, which MessageSpeaker already enforces by
// pausing dictation before it plays.
//
// Long replies do not wait to be spoken whole: on the on-device engine the
// watcher feeds the still-streaming text through VoiceReplyChunker and each
// completed sentence is queued for speech as it lands (stream-and-speak).
// The turn stays `speaking` until the text stream has closed AND the
// utterance queue has drained. Hub and custom engines need the complete
// text, so they keep the settle-then-speak shape.
//
// Approvals outrank the conversation: the moment a pending card appears on
// this thread the whole session tears down and the screen goes back to the
// transcript, where the card already renders.
import AVFoundation
import Combine
import Foundation
import CompanionCore

@MainActor
final class VoiceModeController: ObservableObject {
    /// The live session, for the island's stop button — one voice session
    /// can exist at a time because the app owns a single controller.
    static weak var active: VoiceModeController?

    @Published private(set) var phase: VoiceSessionPhase = .idle
    /// What was heard on the current or last listening turn.
    @Published private(set) var heard = ""
    /// The settled reply, shown while it is spoken.
    @Published private(set) var replyText = ""
    /// Live mic level for the orb, 0...1 after LevelFollower.
    @Published private(set) var micLevel: Float = 0
    /// Live voice-output level for the orb while a reply is spoken,
    /// 0...1 — real playback metering, not a stand-in pulse.
    @Published private(set) var voiceLevel: Float = 0
    /// Microphone mute, synced with the system call mute. Replies still speak.
    @Published var isMuted = false
    /// True while a user-started agent call is live (not after hang-up).
    var isCallActive: Bool { !didShutdown && chat != nil }
    /// Why the island is not live, when it is not — surfaced on the voice
    /// screen instead of failing silently.
    @Published private(set) var islandNote: String?
    /// The chat this session is talking to. Nil when idle and unused.
    @Published private(set) var chat: Chat?
    /// When this session was opened — the time-in-call caption on the
    /// voice screen. Nil when the session is not live.
    @Published private(set) var callStartedAt: Date?

    private let dictation = SpeechDictation()
    private let speaker = MessageSpeaker()
    /// Attack/release smoothing between the raw frames and the orb.
    private var micFollower = LevelFollower()
    private var voiceFollower = LevelFollower(attack: 0.6, release: 0.28)
    private weak var session: Session?
    private var island: VoiceIsland?
    private var onRequestClose: (() -> Void)?
    private var watchTask: Task<Void, Never>?
    private var approvalObserver: AnyCancellable?
    private var interruptionObserver: AnyCancellable?
    private var dictationErrorObserver: AnyCancellable?
#if DEBUG
    private var probeTask: Task<Void, Never>?
#endif

    /// Settling a reply: the send that started the wait, whether the bot was
    /// seen busy since, and the last bot text line before the send so a
    /// fresh reply is recognized by identity, not by content.
    private var sentAt: Date?
    private var sawBusy = false
    private var preSendBotLineIds: Set<String> = []
    /// Whether a card was already pending when the session opened — those
    /// do not close voice mode; only ones that arrive do.
    private var openedWithPendingApproval = false
    private var didShutdown = true
    /// True after a real background/interruption so a launch `.active`
    /// scene-phase pulse cannot idle a session that never left the screen.
    private var suspendedFromBackground = false

    /// Stream-and-speak state for the current reply. `streamSpeakWanted`
    /// is decided once per send — on-device engine, unmuted, the only
    /// engine that can speak text it has not seen all of.
    private var streamSpeakWanted = false
    private var replyChunker: VoiceReplyChunker?
    /// How much of the streamed reply the chunker has already seen.
    private var fedStreamCount = 0
    /// The text side is over: settled, tail flushed, pump closed. Only the
    /// queue drain remains.
    private var streamSettled = false
    /// Sentences flow to the speech task through here; closing it is what
    /// lets the queue drain and the turn end.
    private var chunkPump: AsyncStream<String>.Continuation?
    private var streamTask: Task<Void, Never>?

    private var threadId: String { chat?.threadId ?? "" }

    /// The live chat record, as ChatView keeps it.
    private var current: Chat? {
        guard let session, let chat else { return nil }
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    private func bot(in state: CompanionState) -> Bot? {
        guard let chat, case let .bot(bot) = chat else { return nil }
        return state.bot(bot.id) ?? bot
    }

    // MARK: - Lifecycle

    func activate(chat: Chat, session: Session, islandEnabled: Bool, onRequestClose: @escaping () -> Void) {
        if !didShutdown, self.chat?.stableID == chat.stableID, self.session === session {
            self.onRequestClose = onRequestClose
            return
        }
        if !didShutdown {
            shutdown()
        }
        self.chat = chat
        self.session = session
        self.onRequestClose = onRequestClose
        speaker.dictation = dictation
        speaker.onAmplitude = { [weak self] level in
            guard let self else { return }
            self.voiceLevel = self.voiceFollower.observe(level)
        }
        openedWithPendingApproval = session.state.pendingApprovals.contains { $0.threadId == chat.threadId }
        didShutdown = false
        suspendedFromBackground = false
        isMuted = false
        callStartedAt = Date()
        Self.active = self
        CallAudioSession.configureForCall()
        AgentCallKit.shared.attach(
            close: { [weak self] in self?.close() },
            mute: { [weak self] muted in self?.applySystemMute(muted) }
        )
        AgentCallKit.shared.startOutgoing(handle: chat.name)

        if islandEnabled {
            let liveBot = bot(in: session.state)
            let island = VoiceIsland(
                name: liveBot?.name ?? chat.name,
                color: liveBot?.color ?? "violet",
                shape: liveBot?.mascotShape?.rawValue,
                threadId: chat.threadId
            )
            islandNote = island.start()
            island.update(phase)
            self.island = island
        }

        fire(.opened)

        approvalObserver = session.$state.sink { [weak self] state in
            self?.watchApprovals(in: state)
        }
        // startVoiceSession is fire-and-forget: a denied permission or a
        // dead recognizer only surfaces as the dictation's published error.
        // Left unheard, the island would sit on "Listening…" with no
        // capture. Stale errors from an earlier turn are inert — the guard
        // keeps them from idling a session that never failed.
        dictationErrorObserver = dictation.$error.sink { [weak self] error in
            guard let self, let error, self.phase == .listening else { return }
            self.session?.actionError = error
            self.fire(.micStopped(hasTranscript: false))
        }
        interruptionObserver = NotificationCenter.default
            .publisher(for: AVAudioSession.interruptionNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
                let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt) ?? 0
                if value == AVAudioSession.InterruptionType.began.rawValue {
                    // A call or Siri takes the route; the session stays up
                    // so coming back does not rip the island down.
                    self?.suspendCapture()
                } else if value == AVAudioSession.InterruptionType.ended.rawValue {
                    // The interruption's own resume: without it the flag a
                    // began set would refuse the mic forever on a scene that
                    // never left the screen.
                    self?.resumeAfterForeground()
                }
            }
    }

    /// Background / audio interruption: drop the mic and player, keep the
    /// session and the island. iOS will have already stopped the capture
    /// without a background-audio mode; we just refuse to crash or close.
    func suspendCapture() {
        guard !didShutdown else { return }
        suspendedFromBackground = true
        // The settle watcher polls the session, whose SSE lingers in the
        // background: left alive, a settle fires the loop onward and the
        // next step tries to open the mic while backgrounded.
        watchTask?.cancel()
        watchTask = nil
        dictation.stop()
        speaker.stop()
        endStreamTurn()
        micFollower.reset()
        voiceFollower.reset()
        micLevel = 0
        voiceLevel = 0
#if DEBUG
        probeTask?.cancel()
        probeTask = nil
#endif
        switch phase {
        case .listening, .speaking:
            phase = .idle
            island?.update(phase)
        case .thinking, .idle:
            break
        }
    }

    /// Foreground resume after a real background/interruption. A launch
    /// `.active` pulse must not idle a session that never left the screen.
    func resumeAfterForeground() {
        guard !didShutdown, suspendedFromBackground else { return }
        suspendedFromBackground = false
        // Whatever the route is now, the turn is not what it was: stop both
        // halves before the phase follows them, so idle never sits above an
        // open mic or a live player.
        dictation.stop()
        speaker.stop()
        switch phase {
        case .listening, .thinking:
            // A capture that survived in name only — the route is gone —
            // and a thinking turn whose watcher was cancelled at
            // suspension. Neither can finish; sit down at the orb.
            phase = .idle
            island?.update(phase)
        case .speaking, .idle:
            break
        }
    }

    /// The X, a phone call, the island's stop button, the app backgrounding:
    /// every exit funnels here. Idempotent.
    func close() {
        fire(.closed)
    }

    func shutdown() {
        guard !didShutdown else { return }
        didShutdown = true
        suspendedFromBackground = false
        AgentCallKit.shared.end()
        AgentCallKit.shared.detach()
        if Self.active === self { Self.active = nil }
        watchTask?.cancel()
        watchTask = nil
        endStreamTurn()
        approvalObserver?.cancel()
        approvalObserver = nil
        interruptionObserver?.cancel()
        interruptionObserver = nil
        dictationErrorObserver?.cancel()
        dictationErrorObserver = nil
        dictation.stop()
        speaker.stop()
        micFollower.reset()
        voiceFollower.reset()
        micLevel = 0
        voiceLevel = 0
#if DEBUG
        probeTask?.cancel()
        probeTask = nil
#endif
        island?.end()
        island = nil
        islandNote = nil
        phase = .idle
        chat = nil
        callStartedAt = nil
        CallAudioSession.release()
    }

    // MARK: - Input

    /// The orb: start listening, end a listening turn, barge in on a turn.
    func orbTapped() {
        switch phase {
        case .idle:
            fire(.micReady)
        case .listening:
            finishListening()
        case .thinking:
            if let target = current ?? chat {
                Task { await session?.interrupt(chat: target) }
            }
            fire(.bargeIn)
        case .speaking:
            speaker.stop()
            fire(.bargeIn)
        }
    }

    func toggleMute() {
        applyMute(!isMuted, fromSystem: false)
    }

    /// System call mute from CallKit. Does not re-request CXSetMutedCallAction.
    func applySystemMute(_ muted: Bool) {
        applyMute(muted, fromSystem: true)
    }

    private func applyMute(_ muted: Bool, fromSystem: Bool) {
        guard isMuted != muted else { return }
        isMuted = muted
        if !fromSystem {
            AgentCallKit.shared.setMuted(muted)
        }
        if muted, phase == .listening {
            dictation.stop()
            heard = ""
            fire(.micStopped(hasTranscript: false))
        } else if !muted, phase == .idle {
            fire(.micReady)
        }
    }

    /// The composer in the bottom bar: a typed line joins the same loop —
    /// send, wait, speak the reply (unless muted), listen.
    func sendTyped(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        abandonCycle()
        heard = trimmed
        beginSend(trimmed)
    }

    /// Silence endpointing or a second tap ended the listening turn.
    private func finishListening() {
        guard phase == .listening else { return }
        dictation.stop()
        let heard = dictation.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        self.heard = heard
        fire(.micStopped(hasTranscript: !heard.isEmpty))
    }

    // MARK: - Policy steps

    private func fire(_ event: VoiceSessionEvent) {
        apply(VoiceSessionPolicy.decide(phase: phase, event: event), event: event)
    }

    private func apply(_ decision: VoiceSessionDecision, event: VoiceSessionEvent) {
        switch decision {
        case .stay:
            break
        case .listen:
            beginListening()
        case .idle:
            phase = .idle
            island?.update(phase)
        case .sendTranscript:
            beginSend(heard)
        case .speakReply:
            beginSpeaking()
        case .speakStreamReply:
            beginStreamSpeaking()
        case .stopAll:
            shutdown()
            onRequestClose?()
        }
    }

    private func beginListening() {
        // Suspended from the background, nothing may open the mic — not
        // even a settle that somehow fires before the watcher is cancelled.
        guard !suspendedFromBackground else { return }
        if isMuted {
            phase = .idle
            island?.update(phase)
            return
        }
        watchTask?.cancel()
        watchTask = nil
        endStreamTurn()
        phase = .listening
        heard = ""
        replyText = ""
        micFollower.reset()
        micLevel = 0
        voiceFollower.reset()
        voiceLevel = 0
        island?.update(phase)
        dictation.onLevel = { [weak self] rms in
            guard let self else { return }
#if DEBUG
            // The probe owns the follower so a silent simulator mic cannot
            // pin the orb at zero while we are proving it moves.
            if ProcessInfo.processInfo.arguments.contains("-voice-level-probe") { return }
#endif
            self.micLevel = self.micFollower.observe(VoiceSessionPolicy.normalizedMicLevel(rms: rms))
        }
        dictation.onSilence = { [weak self] in
            self?.finishListening()
        }
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-voice-level-probe") {
            // Skip SFSpeech so the permission sheet does not cover the orb
            // while we prove the follower → TimelineView chain.
            startLevelProbeIfRequested()
            return
        }
#endif
        dictation.startVoiceSession()
    }

    private func beginSend(_ text: String) {
        guard let session, let target = current else {
            phase = .idle
            island?.update(phase)
            return
        }
        phase = .thinking
        island?.update(phase)
        voiceFollower.reset()
        voiceLevel = 0
        sentAt = Date()
        sawBusy = false
        // Direct bot calls may speak sentences as they stream. Team calls wait
        // until the room turn settles so replies from multiple agents can be
        // spoken once, in transcript order, with speaker names.
        streamSpeakWanted = VoiceOutputSettings.load().engine == .onDevice && target.isBot
        replyChunker = streamSpeakWanted ? VoiceReplyChunker() : nil
        fedStreamCount = 0
        streamSettled = false
        preSendBotLineIds = Set(
            session.state.visibleTranscript(forThread: threadId)
                .filter { $0.role == .bot && $0.kind == .text }
                .map(\.id)
        )
        let voiceText = text
        Task { [weak self] in
            guard let self else { return }
            let receipt = await session.send(voiceText, to: target, mode: .auto)
            // A barge-in or close during the round-trip cancels the turn.
            guard self.phase == .thinking else { return }
            if let receipt, receipt.ok {
                session.recordQueueReceipt(receipt, forThread: target.threadId)
                self.startWatchLoop()
            } else {
                self.fire(.sendFailed)
            }
        }
    }

    private func startWatchLoop() {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                // A stream-and-speak turn keeps the loop alive through the
                // speaking phase — it is still feeding sentences in.
                if self.phase != .thinking, self.chunkPump == nil { return }
                if let session = self.session {
                    self.ingestStream(session.state)
                    self.evaluateSettled(session.state)
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
        }
    }

    /// Stream-and-speak: feed the growing reply text through the sentence
    /// chunker and queue every completed sentence for speech. The first
    /// sentence starts the speaking turn at any length, so the bot is
    /// heard before the reply has finished arriving. The transcript line
    /// mirrors the stream as it grows.
    private func ingestStream(_ state: CompanionState) {
        guard streamSpeakWanted, !streamSettled else { return }
        let streamed = state.streaming[threadId] ?? ""
        guard streamed.count > fedStreamCount else { return }
        replyText = streamed
        let start = streamed.index(streamed.startIndex, offsetBy: fedStreamCount)
        let addition = String(streamed[start...])
        fedStreamCount = streamed.count
        for chunk in replyChunker?.feed(addition) ?? [] {
            enqueueStreamChunk(chunk)
        }
    }

    private func enqueueStreamChunk(_ chunk: String) {
        let trimmed = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if chunkPump == nil {
            fire(.streamStarted)
            guard phase == .speaking else { return }
        }
        chunkPump?.yield(trimmed)
    }

    /// Stream-and-speak: the first sentence is ready. The rest queue
    /// through the pump as they complete, and the turn ends when the text
    /// stream has closed and the utterance queue has drained.
    private func beginStreamSpeaking() {
        guard let session, !suspendedFromBackground else { return }
        phase = .speaking
        island?.update(phase)
        let (stream, continuation) = AsyncStream.makeStream(of: String.self)
        chunkPump = continuation
        streamTask = Task { [weak self] in
            guard let self else { return }
            let drained = await self.speaker.speakStream(
                chunks: stream,
                session: session,
                onDeviceVoiceIdentifier: self.onDeviceCallVoiceIdentifier
            )
            // A stopped stream already moved the loop along; only a
            // still-speaking turn ends from here.
            guard self.phase == .speaking else { return }
            if drained {
                self.fire(.replySpoken)
            } else {
                // The engine could not start or died mid-stream with nobody
                // stopping the turn: nothing else would end it, so fail it
                // like a send — the error is already on screen — and let
                // the island clear instead of hanging on "Speaking…".
                self.endStreamTurn()
                self.fire(.sendFailed)
            }
        }
    }

    /// The reply has settled when the bot left busy after having been busy,
    /// or a new bot text line exists while not busy, or the wait ran out.
    /// A stream-and-speak turn is watched through the speaking phase too —
    /// the stream ends here even though speaking began sentences ago.
    private func evaluateSettled(_ state: CompanionState) {
        guard let sentAt, phase == .thinking || (streamSpeakWanted && !streamSettled) else { return }
        let target = current
        let busy: Bool
        switch target {
        case .bot:
            busy = bot(in: state)?.busy == true
        case let .room(room):
            busy = state.rooms.first(where: { $0.id == room.id })?.busyBotId != nil
        case nil:
            busy = false
        }
        if busy { sawBusy = true }

        let transcript = state.visibleTranscript(forThread: threadId)
        let newBotLines = transcript.filter {
            $0.role == .bot && $0.kind == .text && !preSendBotLineIds.contains($0.id)
        }
        let elapsed = Date().timeIntervalSince(sentAt)
        let hasNewLine = !newBotLines.isEmpty
        let timedOut = elapsed >= VoiceSessionPolicy.replyTimeout
        if (sawBusy && !busy) || (hasNewLine && !busy && elapsed > 1) || timedOut {
            if case .room = target {
                replyText = VoiceSessionPolicy.teamReplyText(messages: transcript, excluding: preSendBotLineIds)
            } else if let lastBotLine = newBotLines.last, lastBotLine.text?.isEmpty == false {
                replyText = lastBotLine.text ?? ""
            } else if let streaming = state.streaming[threadId], !streaming.isEmpty {
                replyText = streaming
            } else {
                replyText = ""
            }
            if streamSpeakWanted {
                settleStream()
            } else {
                fire(.replySettled(hasReply: !replyText.isEmpty, shouldSpeak: true))
            }
        }
    }

    /// The text side of a stream-and-speak turn is over: flush whatever
    /// partial sentence is left — nothing spoken stays dangling — close
    /// the pump, and let the drain completion end the turn. A reply that
    /// never produced a sentence falls back to the settled-reply event.
    private func settleStream() {
        streamSettled = true
        if let tail = replyChunker?.flush() {
            enqueueStreamChunk(tail)
        }
        chunkPump?.finish()
        chunkPump = nil
        if phase == .thinking {
            // No sentence ever started speaking; the loop moves on now.
            fire(.replySettled(hasReply: false, shouldSpeak: true))
        }
    }

    /// Tear down the stream-and-speak machinery for the current reply.
    /// Every exit path — barge-in, close, background, approval card, the
    /// turn simply finishing — comes through here, so no pump, task, or
    /// stale chunk outlives the turn.
    private func endStreamTurn() {
        chunkPump?.finish()
        chunkPump = nil
        streamTask?.cancel()
        streamTask = nil
        replyChunker = nil
        fedStreamCount = 0
        streamSettled = false
        streamSpeakWanted = false
    }

    private func beginSpeaking() {
        guard let session else { return }
        phase = .speaking
        island?.update(phase)
        let spoken = replyText
        let voice = voiceId
        Task { [weak self] in
            guard let self else { return }
            await self.speaker.speakForVoiceMode(
                text: spoken,
                voiceId: voice,
                botId: self.botId,
                session: session
            )
            guard self.phase == .speaking else { return }
            self.fire(.replySpoken)
        }
    }

    private var botId: String? {
        guard let chat, case let .bot(bot) = chat else { return nil }
        return bot.id
    }

    private var voiceId: String? {
        guard let session, let chat, case let .bot(bot) = chat else { return nil }
        return session.state.bot(bot.id)?.voice ?? bot.voice
    }

    private var onDeviceCallVoiceIdentifier: String? {
        CallVoicePreferenceStore.resolvedVoice(
            botId: botId ?? "",
            engine: .onDevice,
            serverBotVoice: nil,
            globalCustomVoice: ""
        )
    }

#if DEBUG
    /// `-voice-level-probe` drives onLevel with a known oscillating RMS so
    /// the simulator can prove the orb moves without a working mic. The
    /// real tap still runs and logs; this only fills the follower.
    private func startLevelProbeIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("-voice-level-probe") else { return }
        probeTask?.cancel()
        probeTask = Task { [weak self] in
            var t: Float = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000)
                guard let self, self.phase == .listening else { continue }
                t += 0.18
                let rms = 0.02 + 0.12 * (0.5 + 0.5 * sin(t))
                let next = self.micFollower.observe(VoiceSessionPolicy.normalizedMicLevel(rms: rms))
                self.micLevel = next
                if Int(t * 10) % 8 == 0 {
                    print("voice-level-probe rms=\(rms) micLevel=\(next)")
                }
            }
        }
    }
#endif

    /// Stop a turn that is on its way without leaving voice mode: the typed
    /// line replaces whatever was happening.
    private func abandonCycle() {
        dictation.stop()
        speaker.stop()
        watchTask?.cancel()
        watchTask = nil
        endStreamTurn()
        sentAt = nil
    }

    // MARK: - Approvals

    private func watchApprovals(in state: CompanionState) {
        guard !didShutdown else { return }
        let pending = state.pendingApprovals.contains { $0.threadId == threadId }
        if pending, !openedWithPendingApproval {
            // A needs-you card outranks the conversation: mic and voice
            // stop, the cover lifts, and the card is on the screen.
            approvalObserver?.cancel()
            approvalObserver = nil
            abandonCycle()
            island?.end()
            island = nil
            phase = .idle
            onRequestClose?()
        }
    }
}
