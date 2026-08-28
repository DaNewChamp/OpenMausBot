import SwiftUI
import CompanionCore

/// The small, always-at-hand set of conversations the user chose to keep
/// close. It follows the Grok Bot reference: large left-aligned faces,
/// one-line names, and a horizontal overflow only when the row cannot fit.
struct PinnedChatShelf: View {
    let summaries: [ChatSummary]
    let open: (Chat) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pinPrompt: PendingPinChange?

    var body: some View {
        GeometryReader { proxy in
            let tileWidth: CGFloat = 88
            let spacing: CGFloat = 16
            let capacity = max(1, Int((proxy.size.width - 32 + spacing) / (tileWidth + spacing)))

            Group {
                if summaries.count > capacity {
                    ScrollView(.horizontal, showsIndicators: false) {
                        tileRow(spacing: spacing)
                            .padding(.horizontal, 16)
                    }
                } else {
                    tileRow(spacing: spacing)
                        .padding(.horizontal, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(height: 132)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: summaries.map(\.id))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned conversations")
        .pinConfirmationDialog($pinPrompt, session: session)
    }

    private func tileRow(spacing: CGFloat) -> some View {
        HStack(alignment: .top, spacing: spacing) {
            ForEach(summaries) { summary in
                Button { open(summary.chat) } label: {
                    PinnedChatTile(
                        chat: summary.chat,
                        animated: !reduceMotion && MausState.forChat(summary.chat, in: session.state).showsActivity
                    )
                }
                .buttonStyle(.plain)
                .contextMenu {
                    pinButton(for: summary)
                }
                .disabled(session.pendingPinnedChats.contains(summary.chat.stableID))
            }
        }
    }

    @ViewBuilder
    private func pinButton(for summary: ChatSummary) -> some View {
        Button {
            pinPrompt = PendingPinChange(chat: summary.chat, pinned: summary.pinned)
        } label: {
            Label(summary.pinned ? "Unpin" : "Pin", systemImage: summary.pinned ? "pin.slash" : "pin")
        }
        .disabled(session.pendingPinnedChats.contains(summary.chat.stableID))
    }
}

private struct PinnedChatTile: View {
    let chat: Chat
    let animated: Bool

    var body: some View {
        VStack(spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                PinnedChatAvatar(chat: chat, size: 74, animated: animated)

                if chat.busy {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.white)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.black.opacity(0.78)))
                        .overlay(Circle().stroke(VBotSurface.background, lineWidth: 2))
                }
            }
            .frame(width: 76, height: 76)

            HStack(spacing: 4) {
                Text(chat.name)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                if chat.unread && !chat.busy {
                    Circle()
                        .fill(VBotSurface.unread)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: 88)
        }
        .contentShape(Rectangle())
        .accessibilityLabel(chat.name)
        .accessibilityValue(accessibilityStatus)
    }

    private var accessibilityStatus: String {
        if chat.busy { return "Pinned, working" }
        if chat.unread { return "Pinned, unread" }
        return "Pinned"
    }
}

private struct PinnedChatAvatar: View {
    let chat: Chat
    let size: CGFloat
    let animated: Bool

    @EnvironmentObject private var session: Session

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(
                bot: bot,
                size: size,
                state: MausState.forChat(chat, in: session.state),
                animated: animated
            )
        case let .room(room):
            RoomFaceStack(room: room, size: size, animated: animated)
        }
    }
}
