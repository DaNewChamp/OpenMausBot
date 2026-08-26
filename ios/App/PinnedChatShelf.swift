import SwiftUI
import CompanionCore

/// The small, always-at-hand set of conversations the user chose to keep
/// close. It follows the mobile reference: large centered faces, one-line
/// names, and a horizontal overflow only when the row cannot fit.
struct PinnedChatShelf: View {
    let summaries: [ChatSummary]
    let open: (Chat) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let tileWidth: CGFloat = 108
            let spacing: CGFloat = 24
            let capacity = max(1, Int((proxy.size.width - 48 + spacing) / (tileWidth + spacing)))

            Group {
                if summaries.count > capacity {
                    ScrollView(.horizontal, showsIndicators: false) {
                        tileRow(spacing: spacing)
                            .padding(.horizontal, 24)
                    }
                } else {
                    tileRow(spacing: spacing)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(height: 132)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: summaries.map(\.id))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned conversations")
    }

    private func tileRow(spacing: CGFloat) -> some View {
        HStack(alignment: .top, spacing: spacing) {
            ForEach(summaries) { summary in
                Button { open(summary.chat) } label: {
                    PinnedChatTile(chat: summary.chat, animated: !reduceMotion)
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
            Task { _ = await session.setPinned(!summary.pinned, for: summary.chat) }
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
                PinnedChatAvatar(chat: chat, size: 90, animated: animated)

                if chat.busy {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.white)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.black.opacity(0.78)))
                        .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                } else if chat.unread {
                    Circle()
                        .fill(MausPalette.color(chat.color))
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                }
            }
            .frame(width: 94, height: 94)

            Text(chat.name)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 108)
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
            RoomPinnedAvatar(room: room, size: size, animated: animated)
        }
    }
}

private struct RoomPinnedAvatar: View {
    let room: Room
    let size: CGFloat
    let animated: Bool

    @EnvironmentObject private var session: Session

    var body: some View {
        let bots = room.memberIds.compactMap { session.state.bot($0) }
        ZStack {
            Circle().fill(Color.secondary.opacity(0.14))
            if bots.isEmpty {
                MausAvatar(color: "blue", size: size * 0.66, state: .happy, animated: animated)
            } else {
                ForEach(Array(bots.prefix(3).enumerated()), id: \.element.id) { index, bot in
                    let avatarSize = bots.count == 1 ? size * 0.72 : size * 0.48
                    BotAvatarView(bot: bot, size: avatarSize, state: .happy, animated: animated)
                        .padding(2)
                        .background(Circle().fill(Color(uiColor: .systemBackground)))
                        .offset(roomOffset(index: index, count: min(bots.count, 3), size: size))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private func roomOffset(index: Int, count: Int, size: CGFloat) -> CGSize {
        switch count {
        case 1: return .zero
        case 2:
            return CGSize(width: index == 0 ? -size * 0.17 : size * 0.17,
                          height: index == 0 ? -size * 0.09 : size * 0.09)
        default:
            switch index {
            case 0: return CGSize(width: -size * 0.18, height: -size * 0.16)
            case 1: return CGSize(width: size * 0.18, height: -size * 0.16)
            default: return CGSize(width: 0, height: size * 0.16)
            }
        }
    }
}
