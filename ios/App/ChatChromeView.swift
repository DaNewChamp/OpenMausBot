import CompanionCore
import SwiftUI

/// Chat overflow actions shared by the header and composer plus-menu.
struct ChatPlusAction: Identifiable {
    let id: String
    let systemImage: String
    let title: String
    let subtitle: String
    var destructive = false
    var disabled = false
    let run: () -> Void
}

/// Floating header: back, identity, model picker, computer / overflow.
struct ChatChromeView: View {
    let chat: Chat
    let unreadElsewhere: Int
    let plusActions: [ChatPlusAction]
    @Binding var showingProfile: Bool
    @Binding var showingModelPicker: Bool
    @Binding var showingComputer: Bool
    @Binding var showingVoice: Bool
    @Binding var groupProfileRoom: Room?

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    private var avatarState: MausState {
        MausState.forChat(current, in: session.state)
    }

    var body: some View {
        ScrollEdgeChrome {
            headerBar
        }
    }

    /// Back and the agent sit on the leading edge so the face never covers
    /// the transcript. Chrome is liquid glass; the name and model share one
    /// pill beside the back control.
    private var headerBar: some View {
        HStack(spacing: ConversationLayoutPolicy.chromeButtonGap) {
            Button {
                Haptics.selection()
                dismiss()
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.semibold))
                        .frame(
                            width: ConversationLayoutPolicy.chromeButtonDiameter,
                            height: ConversationLayoutPolicy.chromeButtonDiameter
                        )

                    if unreadElsewhere > 0 {
                        Text(unreadElsewhere > 99 ? "99+" : "\(unreadElsewhere)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color(uiColor: .systemBackground))
                            .padding(.horizontal, 4)
                            .frame(minWidth: 17, minHeight: 17)
                            .background(Capsule().fill(VBotSurface.unread))
                            .offset(x: 4, y: -4)
                    }
                }
                .foregroundStyle(Color.primary)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .glassCircle()
            .fixedSize()
            .accessibilityLabel("Back")
            .accessibilityValue(unreadElsewhere > 0 ? "\(unreadElsewhere) unread elsewhere" : "")

            identityPill

            Spacer(minLength: ConversationLayoutPolicy.chromeButtonGap)

            if case .bot = current {
                Button {
                    Haptics.selection()
                    showingVoice = true
                } label: {
                    Image(systemName: "waveform")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .frame(
                            width: ConversationLayoutPolicy.chromeButtonDiameter,
                            height: ConversationLayoutPolicy.chromeButtonDiameter
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCircle()
                .fixedSize()
                .accessibilityLabel("Live voice with \(current.name)")

                Button {
                    Haptics.selection()
                    showingComputer = true
                } label: {
                    Image(systemName: "display")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .frame(
                            width: ConversationLayoutPolicy.chromeButtonDiameter,
                            height: ConversationLayoutPolicy.chromeButtonDiameter
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCircle()
                .fixedSize()
                .accessibilityLabel("Watch \(current.name)'s computer")
            } else {
                overflowMenu
            }
        }
        .padding(.horizontal, ConversationLayoutPolicy.chromeHorizontalPadding)
        .padding(.top, ConversationLayoutPolicy.chromeTopPadding)
        .padding(.bottom, ConversationLayoutPolicy.chromeBottomPadding)
    }

    @ViewBuilder
    private var identityPill: some View {
        Button {
            Haptics.selection()
            if current.isBot { showingProfile = true }
            else if case let .room(room) = current { groupProfileRoom = room }
        } label: {
            HStack(spacing: 8) {
                ZStack(alignment: .bottomTrailing) {
                    ChatAvatarView(
                        chat: current,
                        size: ConversationLayoutPolicy.identityAvatar,
                        state: avatarState,
                        animated: !reduceMotion && avatarState.showsActivity
                    )
                    Circle()
                        .fill(statusColor)
                        .frame(
                            width: ConversationLayoutPolicy.identityStatusDot,
                            height: ConversationLayoutPolicy.identityStatusDot
                        )
                        .overlay {
                            Circle()
                                .stroke(VBotSurface.background, lineWidth: 1.5)
                        }
                        .offset(x: 2, y: 2)
                        .accessibilityHidden(true)
                }

                Text(identityLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .truncationMode(.tail)
            }
            .padding(.leading, 4)
            .padding(.trailing, 12)
            .frame(minHeight: ConversationLayoutPolicy.chromeButtonDiameter)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .layoutPriority(1)
        .contextMenu {
            if case let .bot(bot) = current {
                Button {
                    showingModelPicker = true
                } label: {
                    Label("Change model", systemImage: "cpu")
                }
                .disabled(bot.busy == true)
            }
            Button {
                session.togglePinned(current)
            } label: {
                Label(
                    current.pinned ? "Unpin" : "Pin",
                    systemImage: current.pinned ? "pin.slash" : "pin"
                )
            }
            .disabled(session.pendingPinnedChats.contains(current.stableID))
        }
        .accessibilityLabel(current.isBot ? "Open \(current.name) profile" : "Open \(current.name) group profile")
        .accessibilityHint(current.isBot ? "Edits this agent's identity, avatar, notifications, and voice" : "Shows group members, instructions, and routines")
    }

    private var identityLabel: String {
        switch current {
        case let .bot(bot):
            let live = session.state.bot(bot.id) ?? bot
            let model = AdvertisedModelCatalog.humanModelLabel(
                selection: live.modelSelection,
                instances: session.modelCatalog
            )
            return ConversationLayoutPolicy.identityTitle(name: live.name, modelLabel: model)
        case .room:
            if case let .room(room) = current,
               let title = BotChannelPolicy.perspectiveTitle(
                   room: room,
                   perspective: session.botChannelPerspective,
                   botName: { session.state.bot($0)?.name }
               ) {
                return title
            }
            return current.name
        }
    }

    private var statusColor: Color {
        if current.busy { return .orange }
        return .green
    }

    @ViewBuilder
    private var overflowMenu: some View {
        Menu {
            ForEach(plusActions) { action in
                Button(role: action.destructive ? .destructive : nil) {
                    action.run()
                } label: {
                    Label(action.title, systemImage: action.systemImage)
                }
                .disabled(action.disabled)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.primary)
                .frame(
                    width: ConversationLayoutPolicy.chromeButtonDiameter,
                    height: ConversationLayoutPolicy.chromeButtonDiameter
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCircle()
        .fixedSize()
        .accessibilityLabel("Open \(current.name) chat options")
    }
}
