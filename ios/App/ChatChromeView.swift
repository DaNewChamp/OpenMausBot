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

    var body: some View {
        ScrollEdgeChrome {
            headerBar
        }
    }

    /// Back and the agent sit on the leading edge so the face never covers
    /// the transcript. Chrome is liquid glass; the name is the title, not a
    /// second pill competing with the face.
    private var headerBar: some View {
        HStack(spacing: 8) {
            Button {
                Haptics.selection()
                dismiss()
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)

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

            Button {
                Haptics.selection()
                if current.isBot { showingProfile = true }
                else if case let .room(room) = current { groupProfileRoom = room }
            } label: {
                HStack(spacing: 8) {
                    ChatAvatarView(
                        chat: current,
                        size: 28,
                        state: MausState.forChat(current, in: session.state),
                        animated: !reduceMotion && MausState.forChat(current, in: session.state).showsActivity
                    )
                    Text(current.name)
                        .font(.headline)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .truncationMode(.tail)
                }
                .padding(.leading, 4)
                .padding(.trailing, 12)
                .frame(minHeight: 40)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .layoutPriority(1)
            .contextMenu {
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

            Spacer(minLength: 8)

            if case let .bot(bot) = current {
                ChatModelPickerButton(bot: bot, showingPicker: $showingModelPicker)
            }

            if case .bot = current {
                Button {
                    Haptics.selection()
                    showingComputer = true
                } label: {
                    Image(systemName: "display")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 40, height: 40)
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
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
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
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCircle()
        .fixedSize()
        .accessibilityLabel("Open \(current.name) chat options")
    }
}
