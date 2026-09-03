// The voice session in the Dynamic Island.
//
// Same attributes and widget the bots use — one more presence kind — so the
// island gains a live voice state without a second activity shape. The
// session is foreground-only: it exists while VoiceModesView is up, and it
// always ends with it. The stop button in the island lands in this process
// via a LiveActivityIntent, same door AnswerApprovalIntent opens.
import ActivityKit
import Foundation
import CompanionCore

@MainActor
final class VoiceIsland {
    /// The attributes botId the voice session runs under. The bots'
    /// coordinator must never reconcile it away, so it stays out of that
    /// fold's namespace.
    static let botId = "voice"

    private let name: String
    private let color: String
    private let shape: String?
    private let threadId: String
    private var activity: Activity<BotActivityAttributes>?

    init(name: String, color: String, shape: String?, threadId: String) {
        self.name = name
        self.color = color
        self.shape = shape
        self.threadId = threadId
    }

    func start() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        StopVoiceModeIntent.handler = {
            await MainActor.run {
                VoiceModeController.active?.close()
            }
        }
        let attributes = BotActivityAttributes(
            botId: Self.botId,
            threadId: threadId,
            name: name,
            color: color,
            shape: shape
        )
        activity = try? Activity.request(
            attributes: attributes,
            content: content(for: .idle),
            pushType: nil
        )
    }

    func update(_ phase: VoiceSessionPhase) {
        guard let activity else { return }
        let content = content(for: phase)
        Task { await activity.update(content) }
    }

    func end() {
        StopVoiceModeIntent.handler = nil
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func content(for phase: VoiceSessionPhase) -> ActivityContent<BotActivityAttributes.ContentState> {
        ActivityContent(
            state: BotActivityAttributes.ContentState(
                face: MausState.idle.rawValue,
                kind: "voice",
                headline: VoiceSessionPolicy.islandHeadline(name: name, phase: phase),
                line: VoiceSessionPolicy.islandLine(for: phase),
                requestId: nil,
                options: [],
                isPermission: false,
                since: activity?.content.state.since ?? Date()
            ),
            staleDate: nil
        )
    }
}
