// The live voice loop, driving the policy.
//
// VoiceSessionPolicy (CompanionCore) decides; this owns the pieces it
// decides between: the SpeechDictation capture, the MessageSpeaker voice
// pipeline, the send path ChatView uses, and the reply watcher that notices
// when a run has settled. Half-duplex on purpose — mic and playback route
// are never negotiated together, which MessageSpeaker already enforces by
// pausing dictation before it plays.
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
    /// can exist at a time because one full-screen cover can.
    static weak var active: VoiceModeController?

    @Published private(set) var phase: VoiceSessionPhase = .idle
    /// What was heard on the current or last listening turn.
    @Published private(set) var heard = ""
    /// The settled reply, shown while it is spoken.
    @Published private(set) var replyText = ""
    /// Live mic level for the orb, 0...~0.5 in a normal room.
    @Published private(set) var micLevel: Float = 0
    /// Mute: replies are read on screen but never spoken.
    @Published var isMuted = false

    private let dictation = SpeechDictation()
    private let speaker = MessageSpeaker()
    private weak var session: Session?
    private let chat: Chat
    private var island: VoiceIsland?
    private var onRequestClose: (() -> Void)?
    private var watchTask: Task<Void, Never>?
    private var approvalObserver: AnyCancellable?
    private var interruptionObserver: AnyCancellable?

    /// Settling a reply: the send that started the wait, whether the bot was
    /// seen busy since, and the last bot text line before the send so a
    /// fresh reply is recognized by identity, not by content.
    private var sentAt: Date?
    private var sawBusy = false
    private var preSendBotLineId: String?
    /// Whether a card was already pending when the session opened — those
    /// do not close voice mode; only ones that arrive do.
    private var openedWithPendingApproval = false
    private var didShutdown = true

    init(chat: Chat) {
        self.chat = chat
    }

    private var threadId: String { chat.threadId }

    /// The live chat record, as ChatView keeps it.
    private var current: Chat? {
        guard let session else { return nil }
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    private func bot(in state: CompanionState) -> Bot? {
        guard case let .bot(bot) = chat else { return nil }
        return state.bot(bot.id) ?? bot
    }

    // MARK: - Lifecycle

    func activate(session: Session, islandEnabled: Bool, onRequestClose: @escaping () -> Void) {
        self.session = session
        self.onRequestClose = onRequestClose
        speaker.dictation = dictation
        openedWithPendingApproval = session.state.pendingApprovals.contains { $0.threadId == threadId }
        didShutdown = false
        Self.active = self

        if islandEnabled {
            let liveBot = bot(in: session.state)
            let island = VoiceIsland(
                name: liveBot?.name ?? chat.name,
                color: liveBot?.color ?? "violet",
                shape: liveBot?.mascotShape?.rawValue,
                threadId: threadId
            )
            island.start()
            island.update(phase)
            self.island = island
        }

        approvalObserver = session.$state.sink { [weak self] state in
            self?.watchApprovals(in: state)
        }
        interruptionObserver = NotificationCenter.default
            .publisher(for: AVAudioSession.interruptionNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
                let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt) ?? 0
                if value == AVAudioSession.InterruptionType.began.rawValue {
                    self?.close()
                }
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
        if Self.active === self { Self.active = nil }
        watchTask?.cancel()
        watchTask = nil
        approvalObserver?.cancel()
        approvalObserver = nil
        interruptionObserver?.cancel()
        interruptionObserver = nil
        dictation.stop()
        speaker.stop()
        island?.end()
        island = nil
        phase = .idle
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
            Task { await session?.interrupt(chat: current ?? chat) }
            fire(.bargeIn)
        case .speaking:
            speaker.stop()
            fire(.bargeIn)
        }
    }

    func toggleMute() {
        isMuted.toggle()
        // Taking the mute off mid-turn does not retroactively speak; the
        // next reply obeys the new setting.
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
        case .stopAll:
            shutdown()
            onRequestClose?()
        }
    }

    private func beginListening() {
        watchTask?.cancel()
        watchTask = nil
        phase = .listening
        heard = ""
        replyText = ""
        micLevel = 0
        island?.update(phase)
        dictation.onLevel = { [weak self] level in
            self?.micLevel = level
        }
        dictation.onSilence = { [weak self] in
            self?.finishListening()
        }
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
        sentAt = Date()
        sawBusy = false
        preSendBotLineId = session.state
            .visibleTranscript(forThread: threadId)
            .last(where: { $0.role == .bot && $0.kind == .text })?.id
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
                if self.phase != .thinking { return }
                if let session = self.session {
                    self.evaluateSettled(session.state)
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
        }
    }

    /// The reply has settled when the bot left busy after having been busy,
    /// or a new bot text line exists while not busy, or the wait ran out.
    private func evaluateSettled(_ state: CompanionState) {
        guard phase == .thinking, let sentAt else { return }
        let busy = bot(in: state)?.busy == true
        if busy { sawBusy = true }
        let lastBotLine = state.visibleTranscript(forThread: threadId)
            .last(where: { $0.role == .bot && $0.kind == .text })
        let elapsed = Date().timeIntervalSince(sentAt)
        let hasNewLine = lastBotLine?.id != preSendBotLineId
        let timedOut = elapsed >= VoiceSessionPolicy.replyTimeout
        if (sawBusy && !busy) || (hasNewLine && !busy && elapsed > 1) || timedOut {
            if lastBotLine?.text?.isEmpty == false {
                replyText = lastBotLine?.text ?? ""
            } else if let streaming = state.streaming[threadId], !streaming.isEmpty {
                replyText = streaming
            } else {
                replyText = ""
            }
            fire(.replySettled(hasReply: !replyText.isEmpty, shouldSpeak: !isMuted))
        }
    }

    private func beginSpeaking() {
        guard let session else { return }
        phase = .speaking
        island?.update(phase)
        let spoken = replyText
        let voice = voiceId
        Task { [weak self] in
            guard let self else { return }
            await self.speaker.speakForVoiceMode(text: spoken, voiceId: voice, session: session)
            guard self.phase == .speaking else { return }
            self.fire(.replySpoken)
        }
    }

    private var voiceId: String? {
        guard let session, case let .bot(bot) = chat else { return nil }
        return session.state.bot(bot.id)?.voice ?? bot.voice
    }

    /// Stop a turn that is on its way without leaving voice mode: the typed
    /// line replaces whatever was happening.
    private func abandonCycle() {
        dictation.stop()
        speaker.stop()
        watchTask?.cancel()
        watchTask = nil
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
