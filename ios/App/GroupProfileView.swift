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
    @State private var routinesLoading = true
    @State private var showingInstructions = false
    @State private var showingResponderPicker = false
    @State private var draftInstructions = ""
    @State private var draftResponder: GroupResponder = GroupResponder(kind: "mentions", botId: nil)
    @State private var savingSetup = false

    private var currentRoom: Room {
        session.state.rooms.first { $0.id == room.id } ?? room
    }

    private var members: [Bot] {
        currentRoom.memberIds.compactMap { session.state.bot($0) }
    }

    private var routingMembers: [GroupRouting.Member] {
        members.map {
            GroupRouting.Member(id: $0.id, name: $0.name, hidden: $0.hidden == true, color: $0.color)
        }
    }

    private var canEditSetup: Bool {
        CalmSurfacePolicy.canEditRemoteContent(
            isLive: session.status == .live,
            hasConnection: session.connection != nil
        )
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                groupMark
                    .padding(.top, 18)

                Text(currentRoom.name)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .vbotCard()
                    .accessibilityAddTraits(.isHeader)

                if !canEditSetup {
                    ReconnectToEditBanner()
                }

                NavigationLink(value: Chat.room(currentRoom)) {
                    Label("Open chat", systemImage: "bubble.left.and.bubble.right.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: VBotSurface.Hit.row)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: VBotSurface.Radius.button, style: .continuous))
                }
                .buttonStyle(.plain)

                membersCard
                instructionsCard
                defaultResponderCard
                toolActivityCard
                routinesCard
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
        .vbotCanvas()
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .background {
            InteractivePopGestureEnabler()
                .frame(width: 0, height: 0)
        }
        .safeAreaInset(edge: .top, spacing: 0) { topBar }
        .task {
            let loaded = await session.loadRoutines()
            let incoming = loaded.routines.filter { currentRoom.memberIds.contains($0.botId) }
            let failed = session.status != .live && incoming.isEmpty && !routines.isEmpty
            routines = CalmSurfacePolicy.selectCatalog(cached: routines, incoming: incoming, failed: failed)
            routinesLoading = false
        }
        .sheet(isPresented: $showingInstructions) {
            instructionsEditor
        }
        .sheet(isPresented: $showingResponderPicker) {
            responderPicker
        }
    }

    private var toolActivityCard: some View {
        ActivityDetailOverridePicker(threadId: currentRoom.threadId)
            .padding(18)
            .vbotCard()
    }

    private var topBar: some View {
        HStack {
            GlassButton(systemImage: "chevron.left") {
                Haptics.selection()
                dismiss()
            }
            .accessibilityLabel("Back")

            Spacer()

            Menu {
                Button {
                    PlatformBridge.copyToPasteboard(currentRoom.id)
                } label: {
                    Label("Copy ID", systemImage: "doc.on.doc")
                }
                Button {
                    session.togglePinned(.room(currentRoom))
                } label: {
                    Label(currentRoom.pinned == true ? "Unpin" : "Pin", systemImage: currentRoom.pinned == true ? "pin.slash" : "pin")
                }
                .disabled(session.pendingPinnedChats.contains("room:\(currentRoom.id)"))
            } label: {
                GlassChromeGlyph(systemImage: "ellipsis")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Group actions")
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, VBotSurface.Space.page)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(VBotSurface.background)
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
                        .background(VBotSurface.controlSurface, in: Circle())
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
                        .frame(minHeight: VBotSurface.Hit.row)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open 1:1 with \(bot.name)")
                    if index < members.count - 1 {
                        VBotHairline().padding(.leading, 62)
                    }
                }
            }
            .vbotCard()

            Text("Groups can have up to 6 members.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
        }
    }

    private var instructionsCard: some View {
        Button {
            draftInstructions = currentRoom.bulletin
            showingInstructions = true
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color.secondary)
                        .frame(width: 28)
                    Text("Instructions")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                    Spacer()
                    if canEditSetup {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.secondary)
                    }
                }

                Text(currentRoom.bulletin.isEmpty ? "No instructions" : currentRoom.bulletin)
                    .font(.body)
                    .foregroundStyle(currentRoom.bulletin.isEmpty ? Color.secondary : Color.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .frame(minHeight: VBotSurface.Hit.row, alignment: .leading)
            .vbotCard()
        }
        .buttonStyle(.plain)
        .disabled(!canEditSetup && currentRoom.bulletin.isEmpty)
        .accessibilityHint(canEditSetup ? "Edit group instructions" : "Instructions")
    }

    private var defaultResponderCard: some View {
        Button {
            draftResponder = GroupRouting.effectiveDefaultResponder(
                currentRoom.defaultResponder,
                members: routingMembers
            )
            showingResponderPicker = true
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Image(systemName: "person.wave.2")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color.secondary)
                        .frame(width: 28)
                    Text("Default responder")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                    Spacer()
                    if canEditSetup {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.secondary)
                    }
                }

                Text(responderSummary)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                Text(GroupRouting.groupResponseHint(room: currentRoom, members: routingMembers))
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .frame(minHeight: VBotSurface.Hit.row, alignment: .leading)
            .vbotCard()
        }
        .buttonStyle(.plain)
        .disabled(!canEditSetup)
        .accessibilityHint(canEditSetup ? "Choose who responds by default" : "Shown when connected")
    }

    private var responderSummary: String {
        let value = GroupRouting.effectiveDefaultResponder(currentRoom.defaultResponder, members: routingMembers)
        switch value.kind {
        case "everyone": return "Everyone"
        case "mentions": return "Mentions only"
        default:
            let name = members.first { $0.id == value.botId }?.name ?? "Lead bot"
            return name
        }
    }

    private var instructionsEditor: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Shared instructions for every bot in this group.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)

                TextEditor(text: $draftInstructions)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .vbotControlSurface()
                    .padding(.horizontal, 20)
                    .onChange(of: draftInstructions) { _, value in
                        if value.count > 12_000 {
                            draftInstructions = String(value.prefix(12_000))
                        }
                    }

                Text("\(draftInstructions.count)/12,000")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 20)

                Spacer(minLength: 0)
            }
            .padding(.top, 12)
            .vbotCanvas()
            .navigationTitle("Instructions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingInstructions = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await saveInstructions() }
                    }
                    .disabled(savingSetup || draftInstructions == currentRoom.bulletin)
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var responderPicker: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Mode", selection: responderKindBinding) {
                        Text("Everyone").tag("everyone")
                        Text("Mentions only").tag("mentions")
                        Text("Lead bot").tag("member")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .vbotRowSurface()

                    if draftResponder.kind == "member" {
                        Picker("Lead bot", selection: leadBotBinding) {
                            ForEach(members) { bot in
                                Text(bot.name).tag(bot.id)
                            }
                        }
                        .vbotRowSurface()
                    }
                } footer: {
                    Text(GroupRouting.groupResponseHint(room: currentRoom, members: routingMembers))
                }
            }
            .vbotGroupedChrome()
            .navigationTitle("Default responder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingResponderPicker = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await saveResponder() }
                    }
                    .disabled(savingSetup || draftResponder == currentRoom.defaultResponder)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var responderKindBinding: Binding<String> {
        Binding(
            get: { draftResponder.kind },
            set: { kind in
                switch kind {
                case "everyone", "mentions":
                    draftResponder = GroupResponder(kind: kind, botId: nil)
                case "member":
                    let botId = draftResponder.botId ?? members.first?.id
                    draftResponder = GroupResponder(kind: "member", botId: botId)
                default:
                    break
                }
            }
        )
    }

    private var leadBotBinding: Binding<String> {
        Binding(
            get: { draftResponder.botId ?? members.first?.id ?? "" },
            set: { draftResponder = GroupResponder(kind: "member", botId: $0) }
        )
    }

    @MainActor
    private func saveInstructions() async {
        savingSetup = true
        defer { savingSetup = false }
        if await session.updateGroupSetup(
            roomId: currentRoom.id,
            bulletin: draftInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
        ) != nil {
            showingInstructions = false
        }
    }

    @MainActor
    private func saveResponder() async {
        savingSetup = true
        defer { savingSetup = false }
        if await session.updateGroupSetup(
            roomId: currentRoom.id,
            defaultResponder: draftResponder
        ) != nil {
            showingResponderPicker = false
        }
    }

    private var routinesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Routines")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)

            VStack(alignment: .leading, spacing: 0) {
                if CalmSurfacePolicy.showsSkeleton(isLoading: routinesLoading, hasCachedRows: !routines.isEmpty) {
                    CalmSkeletonList(rows: 3, label: "Loading routines")
                } else if routines.isEmpty {
                    Text("No routines yet")
                        .font(.body)
                        .foregroundStyle(Color.secondary)
                        .padding(.horizontal, 16)
                        .frame(minHeight: VBotSurface.Hit.row, alignment: .leading)
                } else {
                    ForEach(Array(routines.prefix(4).enumerated()), id: \.element.id) { index, routine in
                        NavigationLink {
                            TasksRoutinesView()
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "clock")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(VBotSurface.routineIcon)
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
                            .frame(minHeight: VBotSurface.Hit.row)
                        }
                        .buttonStyle(.plain)
                        if index < min(routines.count, 4) - 1 {
                            VBotHairline().padding(.leading, 56)
                        }
                    }
                }

                VBotHairline()

                NavigationLink {
                    TasksRoutinesView()
                } label: {
                    Label("Add routine", systemImage: "plus")
                        .font(.body)
                        .foregroundStyle(Color.accentColor)
                        .padding(.horizontal, 16)
                        .frame(minHeight: VBotSurface.Hit.row, alignment: .leading)
                }
                .disabled(!canEditSetup)
            }
            .vbotCard()
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
