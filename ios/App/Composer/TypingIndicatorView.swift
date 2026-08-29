import SwiftUI
import CompanionCore

public struct TypingIndicatorView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    public init() {}

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            HStack(spacing: 4) {
                ForEach(0..<3) { index in
                    Circle()
                        .fill(dotColor)
                        .frame(width: 5, height: 5)
                        .scaleEffect(reduceMotion ? 1 : dotScale(index, at: context.date))
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .accessibilityHidden(true)
    }

    private var dotColor: Color {
        colorScheme == .dark ? .white.opacity(0.78) : Color.primary.opacity(0.42)
    }

    private func dotScale(_ index: Int, at date: Date) -> CGFloat {
        let elapsed = date.timeIntervalSinceReferenceDate - Double(index) * 0.16
        let wave = (sin(elapsed * .pi * 2) + 1) / 2
        return 0.35 + CGFloat(wave) * 0.65
    }
}

/// A compact “working” row: the agent’s face plus neutral typing dots.
struct WorkingTypingIndicatorView: View {
    let chat: Chat
    let speakerBotId: String?

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(chat: Chat, speakerBotId: String? = nil) {
        self.chat = chat
        self.speakerBotId = speakerBotId
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if let bot = resolvedBot {
                BotAvatarView(bot: bot, size: 22, state: .working, animated: !reduceMotion)
            } else {
                ChatAvatarView(chat: chat, size: 22, state: .working, animated: !reduceMotion)
            }
            TypingIndicatorView()
        }
        .padding(.vertical, 4)
    }

    private var resolvedBot: Bot? {
        if let speakerBotId { return session.state.bot(speakerBotId) }
        if case let .bot(bot) = chat { return bot }
        if case let .room(room) = chat, let id = room.busyBotId { return session.state.bot(id) }
        return nil
    }
}
