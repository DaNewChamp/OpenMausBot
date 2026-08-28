import SwiftUI
import CompanionCore

/// The small, always-at-hand set of conversations the user chose to keep
/// close. Grok Bot sizes this as three cells across the pane: the face
/// fills the cell minus a little padding, and extra pins scroll.
struct PinnedChatShelf: View {
    let summaries: [ChatSummary]
    let open: (Chat) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let columns = 3
    private static let gutter: CGFloat = 10
    private static let coverAvatar: CGFloat = 80
    private static let cellPadding: CGFloat = 8
    private static let nameBlock: CGFloat = 36

    var body: some View {
        GeometryReader { proxy in
            let metrics = Self.metrics(for: proxy.size.width)
            Group {
                if summaries.count > Self.columns {
                    ScrollView(.horizontal, showsIndicators: false) {
                        tileRow(metrics: metrics)
                            .padding(.horizontal, 16)
                    }
                } else {
                    tileRow(metrics: metrics)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.horizontal, 16)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(height: Self.coverAvatar + Self.nameBlock)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: summaries.map(\.id))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned conversations")
    }

    private static func metrics(for paneWidth: CGFloat) -> (avatar: CGFloat, tile: CGFloat, spacing: CGFloat) {
        let inner = max(paneWidth - 32, 1)
        let cell = max(0, inner / CGFloat(columns) - gutter * 2)
        let avatar = min(coverAvatar, max(64, cell - cellPadding * 2))
        let tile = max(avatar, cell)
        return (avatar, tile, gutter * 2)
    }

    private func tileRow(metrics: (avatar: CGFloat, tile: CGFloat, spacing: CGFloat)) -> some View {
        HStack(alignment: .top, spacing: metrics.spacing) {
            ForEach(summaries) { summary in
                Button { open(summary.chat) } label: {
                    PinnedChatTile(
                        chat: summary.chat,
                        avatarSize: metrics.avatar,
                        tileWidth: metrics.tile,
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
            session.togglePinned(summary.chat)
        } label: {
            Label(summary.pinned ? "Unpin" : "Pin", systemImage: summary.pinned ? "pin.slash" : "pin")
        }
        .disabled(session.pendingPinnedChats.contains(summary.chat.stableID))
    }
}

private struct PinnedChatTile: View {
    let chat: Chat
    let avatarSize: CGFloat
    let tileWidth: CGFloat
    let animated: Bool

    var body: some View {
        VStack(spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                PinnedChatAvatar(chat: chat, size: avatarSize, animated: animated)

                if chat.busy {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.white)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.black.opacity(0.78)))
                        .overlay(Circle().stroke(VBotSurface.background, lineWidth: 2))
                }
            }
            .frame(width: avatarSize, height: avatarSize)

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
            .frame(width: tileWidth)
        }
        .frame(width: tileWidth)
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
