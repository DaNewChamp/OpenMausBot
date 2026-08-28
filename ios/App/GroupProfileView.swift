import SwiftUI
import UIKit
import CompanionCore

/// Group details. A group is a conversation, but its identity is
/// the set of agents in it, so the details surface leads with their stacked
/// marks and keeps the member list one tap away.
struct GroupProfileView: View {
    let room: Room

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var routines: [Routine] = []
    @State private var pinPrompt: PendingPinChange?

    private var currentRoom: Room {
        session.state.rooms.first { $0.id == room.id } ?? room
    }

    private var members: [Bot] {
        currentRoom.memberIds.compactMap { session.state.bot($0) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                groupMark
                    .padding(.top, 18)

                Text(currentRoom.name)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .accessibilityAddTraits(.isHeader)

                NavigationLink(value: Chat.room(currentRoom)) {
                    Label("Open chat", systemImage: "bubble.left.and.bubble.right.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)

                membersCard
                instructionsCard
                routinesCard
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
        .background(GroupProfileStyle.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .background {
            InteractivePopGestureEnabler()
                .frame(width: 0, height: 0)
        }
        .safeAreaInset(edge: .top, spacing: 0) { topBar }
        .task {
            let loaded = await session.loadRoutines()
            routines = loaded.routines.filter { currentRoom.memberIds.contains($0.botId) }
        }
        .pinConfirmationDialog($pinPrompt, session: session)
    }

    private var topBar: some View {
        HStack {
            ChromeCircleButton(systemImage: "chevron.left") {
                Haptics.selection()
                dismiss()
            }
            .accessibilityLabel("Back")

            Spacer()

            Menu {
                Button {
                    UIPasteboard.general.string = currentRoom.id
                } label: {
                    Label("Copy ID", systemImage: "doc.on.doc")
                }
                Button {
                    pinPrompt = PendingPinChange(chat: .room(currentRoom))
                } label: {
                    Label(currentRoom.pinned == true ? "Unpin" : "Pin", systemImage: currentRoom.pinned == true ? "pin.slash" : "pin")
                }
                .disabled(session.pendingPinnedChats.contains("room:\(currentRoom.id)"))
            } label: {
                ChromeCircleButton(systemImage: "ellipsis")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Group actions")
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(GroupProfileStyle.canvas)
    }

    private var groupMark: some View {
        let shown = Array(members.prefix(3))
        let overflow = max(0, members.count - 3)
        return ZStack {
            if members.isEmpty {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(Color.secondary)
            } else if members.count == 1 {
                BotAvatarView(
                    bot: members[0],
                    size: 108,
                    state: MausState.forChat(.bot(members[0]), in: session.state),
                    animated: !reduceMotion && members[0].isWorking
                )
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, bot in
                    BotAvatarView(
                        bot: bot,
                        size: 64,
                        state: MausState.forChat(.bot(bot), in: session.state),
                        animated: !reduceMotion && bot.isWorking
                    )
                    .offset(markOffset(index: index, count: overflow > 0 ? 4 : shown.count))
                }
                if overflow > 0 {
                    Text("+\(overflow)")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .frame(width: 56, height: 56)
                        .background(GroupProfileStyle.control, in: Circle())
                        .offset(markOffset(index: 3, count: 4))
                        .accessibilityHidden(true)
                }
            }
        }
        .frame(width: 168, height: 140)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(members.count) group members")
    }

    private var membersCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 0) {
                ForEach(Array(members.enumerated()), id: \.element.id) { index, bot in
                    NavigationLink(value: Chat.bot(bot)) {
                        HStack(spacing: 12) {
                            BotAvatarView(
                                bot: bot,
                                size: 34,
                                state: MausState.forChat(.bot(bot), in: session.state),
                                animated: !reduceMotion && bot.isWorking
                            )
                            Text(bot.name)
                                .font(.body)
                                .foregroundStyle(Color.primary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.secondary)
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 56)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open 1:1 with \(bot.name)")
                    if index < members.count - 1 {
                        Divider().overlay(GroupProfileStyle.divider).padding(.leading, 62)
                    }
                }
            }
            .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

            Text("Groups can have up to 6 members.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
        }
    }

    private var instructionsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 28)
                Text("Instructions")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
            }

            Text(currentRoom.bulletin.isEmpty ? "No instructions" : currentRoom.bulletin)
                .font(.body)
                .foregroundStyle(currentRoom.bulletin.isEmpty ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 16)
        .frame(minHeight: 56)
        .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var routinesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Routines")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)

            VStack(alignment: .leading, spacing: 0) {
                if routines.isEmpty {
                    Text("No routines yet")
                        .font(.body)
                        .foregroundStyle(Color.secondary)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 56, alignment: .leading)
                } else {
                    ForEach(Array(routines.prefix(4).enumerated()), id: \.element.id) { index, routine in
                        NavigationLink {
                            TasksRoutinesView()
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "clock")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(Color(red: 0.58, green: 0.45, blue: 1))
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(routine.name).font(.body).foregroundStyle(Color.primary)
                                    Text(ProfileScheduleText.summary(routine))
                                        .font(.footnote)
                                        .foregroundStyle(Color.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.secondary)
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: 58)
                        }
                        .buttonStyle(.plain)
                        if index < min(routines.count, 4) - 1 {
                            Divider().overlay(GroupProfileStyle.divider).padding(.leading, 56)
                        }
                    }
                }

                Divider().overlay(GroupProfileStyle.divider)

                NavigationLink {
                    TasksRoutinesView()
                } label: {
                    Label("Add routine", systemImage: "plus")
                        .font(.body)
                        .foregroundStyle(Color.accentColor)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 52, alignment: .leading)
                }
            }
            .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private func markOffset(index: Int, count: Int) -> CGSize {
        switch count {
        case 1: return .zero
        case 2:
            return CGSize(width: index == 0 ? -36 : 36, height: 0)
        case 3:
            switch index {
            case 0: return CGSize(width: -36, height: -28)
            case 1: return CGSize(width: 36, height: -28)
            default: return CGSize(width: 0, height: 30)
            }
        default:
            switch index {
            case 0: return CGSize(width: -36, height: -28)
            case 1: return CGSize(width: 36, height: -28)
            case 2: return CGSize(width: -36, height: 30)
            default: return CGSize(width: 36, height: 30)
            }
        }
    }
}

private enum GroupProfileStyle {
    static let canvas = VBotSurface.background
    static let card = VBotSurface.card
    static let control = VBotSurface.controlSurface
    static let divider = Color.primary.opacity(0.09)
}
