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

    var body: some View {
        GeometryReader { proxy in
            let layout = PinnedChatShelfLayout.metrics(paneWidth: proxy.size.width)
            let overflowing = PinnedChatShelfLayout.overflows(pinCount: summaries.count)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: layout.spacing) {
                    ForEach(summaries) { summary in
                        Button { open(summary.chat) } label: {
                            PinnedChatTile(
                                chat: summary.chat,
                                avatarSize: layout.avatar,
                                tileWidth: layout.tile,
                                animated: !reduceMotion && MausState.forChat(summary.chat, in: session.state).showsActivity
                            )
                        }
                        .buttonStyle(.plain)
                        .frame(minWidth: VBotSurface.Hit.minimum, minHeight: VBotSurface.Hit.minimum)
                        .contextMenu {
                            pinButton(for: summary)
                        }
                        .disabled(session.pendingPinnedChats.contains(summary.chat.stableID))
                        .transition(tileTransition)
                    }
                }
                .padding(.horizontal, PinnedChatShelfLayout.pagePadding)
                .frame(
                    minWidth: proxy.size.width,
                    alignment: overflowing ? .leading : .center
                )
            }
            .scrollBounceBehavior(overflowing ? .always : .basedOnSize, axes: .horizontal)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(height: PinnedChatShelfLayout.reservedHeight)
        .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: summaries.map(\.id))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned conversations")
    }

    private var tileTransition: AnyTransition {
        if reduceMotion {
            return .opacity
        }
        return .asymmetric(
            insertion: .scale(scale: 0.92).combined(with: .opacity),
            removal: .scale(scale: 0.92).combined(with: .opacity)
        )
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
                        .background(Circle().fill(VBotSurface.controlSurface.opacity(0.92)))
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
