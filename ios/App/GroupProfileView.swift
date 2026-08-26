import SwiftUI
import CompanionCore

/// Grok-shaped group details. A group is a conversation, but its identity is
/// the set of agents in it, so the details surface leads with their stacked
/// marks and keeps the member list one tap away.
struct GroupProfileView: View {
    let room: Room

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var routines: [Routine] = []

    private var currentRoom: Room {
        session.state.rooms.first { $0.id == room.id } ?? room
    }

    private var members: [Bot] {
        currentRoom.memberIds.compactMap { session.state.bot($0) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                groupMark
                    .padding(.top, 18)

                Text(currentRoom.name)
                    .font(.system(size: 21, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

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
        .safeAreaInset(edge: .top, spacing: 0) { topBar }
        .task {
            let loaded = await session.loadRoutines()
            routines = loaded.routines.filter { currentRoom.memberIds.contains($0.botId) }
        }
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(GroupProfileStyle.control, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")

            Spacer()

            Menu {
                Button {
                    UIPasteboard.general.string = currentRoom.id
                } label: {
                    Label("Copy ID", systemImage: "doc.on.doc")
                }
                Button {
                    Task { _ = await session.setPinned(!(currentRoom.pinned ?? false), for: .room(currentRoom)) }
                } label: {
                    Label(currentRoom.pinned == true ? "Unpin" : "Pin", systemImage: currentRoom.pinned == true ? "pin.slash" : "pin")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(GroupProfileStyle.control, in: Circle())
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
        ZStack {
            ForEach(Array(members.prefix(4).enumerated()), id: \.element.id) { index, bot in
                BotAvatarView(
                    bot: bot,
                    size: members.count == 1 ? 106 : 68,
                    state: MausState.forChat(.bot(bot), in: session.state),
                    animated: !reduceMotion && bot.isWorking
                )
                .background(Circle().fill(GroupProfileStyle.canvas))
                .offset(markOffset(index: index, count: min(members.count, 4)))
            }
            if members.isEmpty {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(Color.secondary)
            }
        }
        .frame(width: 170, height: 126)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(members.count) group members")
    }

    private var membersCard: some View {
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
                            .font(.system(size: 16))
                            .foregroundStyle(Color.primary)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 58)
                }
                .buttonStyle(.plain)
                if index < members.count - 1 {
                    Divider().overlay(GroupProfileStyle.divider).padding(.leading, 62)
                }
            }
        }
        .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var instructionsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Instructions")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.primary)
                    Text(currentRoom.bulletin.isEmpty ? "Tell this group how to work" : currentRoom.bulletin)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 64)
        }
        .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var routinesCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            if routines.isEmpty {
                Text("No routines yet")
                    .font(.system(size: 16))
                    .foregroundStyle(Color.secondary)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 58, alignment: .leading)
            } else {
                ForEach(routines.prefix(4)) { routine in
                    HStack(spacing: 12) {
                        Image(systemName: "clock")
                            .foregroundStyle(Color.purple)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(routine.name).font(.system(size: 16)).foregroundStyle(Color.primary)
                            Text(routineSummary(routine.schedule))
                                .font(.system(size: 13))
                                .foregroundStyle(Color.secondary)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 58)
                }
            }

            Divider().overlay(GroupProfileStyle.divider)

            NavigationLink {
                TasksRoutinesView()
            } label: {
                Label("Add routine", systemImage: "plus")
                    .font(.system(size: 16))
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 56, alignment: .leading)
            }
        }
        .background(GroupProfileStyle.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func markOffset(index: Int, count: Int) -> CGSize {
        switch count {
        case 1: return .zero
        case 2:
            return CGSize(width: index == 0 ? -30 : 30, height: index == 0 ? -8 : 8)
        case 3:
            switch index {
            case 0: return CGSize(width: -28, height: -16)
            case 1: return CGSize(width: 28, height: -16)
            default: return CGSize(width: 0, height: 25)
            }
        default:
            switch index {
            case 0: return CGSize(width: -30, height: -18)
            case 1: return CGSize(width: 30, height: -18)
            case 2: return CGSize(width: -30, height: 28)
            default: return CGSize(width: 30, height: 28)
            }
        }
    }

    private func routineSummary(_ schedule: RoutineSchedule) -> String {
        switch schedule.type {
        case .once:
            guard let at = schedule.at else { return "One time" }
            return Date(timeIntervalSince1970: at / 1_000).formatted(date: .abbreviated, time: .shortened)
        case .daily:
            let days = schedule.weekdays ?? []
            let dayText: String
            if days.count == 7 { dayText = "Every day" }
            else if days == [1, 2, 3, 4, 5] { dayText = "Weekdays" }
            else { dayText = "Selected days" }
            return "\(dayText) at \(schedule.time ?? "—")"
        case .unknown:
            return "Newer schedule"
        }
    }
}

private enum GroupProfileStyle {
    static let canvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.055, green: 0.055, blue: 0.06, alpha: 1)
            : .systemBackground
    })
    static let card = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.115, green: 0.115, blue: 0.125, alpha: 1)
            : UIColor.secondarySystemBackground
    })
    static let control = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.16, green: 0.16, blue: 0.17, alpha: 1)
            : UIColor.tertiarySystemBackground
    })
    static let divider = Color.primary.opacity(0.09)
}
