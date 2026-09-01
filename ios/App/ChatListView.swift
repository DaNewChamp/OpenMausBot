// The roster.
//
// a near-black Grok Bot home: your profile and two glass actions at the top,
// pinned faces in a generous hero row, then one clean list of every other
// chat. The transcript and roster remain the visual focus; chrome should not
// compete with them.
import SwiftUI
import CompanionCore
import UIKit

struct ChatListView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    /// Driven so that making a bot can open it. Value-based navigation alone
    /// cannot push without a tap, and a new bot appearing silently at the
    /// bottom of the roster is a poor answer to pressing +.
    @State private var path = NavigationPath()
    @State private var searchHits: [SearchHit] = []
    @State private var searching = false
    @State private var searchOpen = false
    @State private var showingUpdates = false
    @State private var showingNewGroup = false
    @State private var showingAccount = false
    @State private var groupProfile: Room?
    @State private var pinnedShelfCollapseReserve = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        NavigationStack(path: $path) {
            GeometryReader { geo in
            VStack(spacing: 0) {
                header
                StatusBanner()

                if query.isEmpty,
                   CalmSurfacePolicy.reservesPinnedShelfRegion(
                    pinCount: pinnedChats.count,
                    animatingCollapse: pinnedShelfCollapseReserve
                ) {
                    PinnedChatShelf(summaries: pinnedChats) { chat in
                        Haptics.selection()
                        open(chat)
                    }
                }

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !query.isEmpty, !searchHits.isEmpty {
                            HStack {
                                Spacer()
                                if searching { ProgressView().controlSize(.small) }
                            }
                            .frame(height: 1)
                            .padding(.horizontal, HomeRosterLayoutPolicy.pagePadding)

                            ForEach(searchHits) { hit in
                                Button {
                                    Task {
                                        if let chat = await session.open(hit) {
                                            Haptics.selection()
                                            path.append(chat)
                                        }
                                    }
                                } label: {
                                    SearchHitRow(hit: hit)
                                }
                                .buttonStyle(.plain)
                                .padding(.horizontal, HomeRosterLayoutPolicy.pagePadding)
                            }
                        }

                        let rows = chats
                        ForEach(rows) { summary in
                            NavigationLink(value: summary.chat) {
                                ChatRow(
                                    chat: summary.chat,
                                    preview: summary.preview,
                                    at: summary.lastActivity,
                                    state: MausState.forChat(summary.chat, in: session.state),
                                    waiting: waitingChats.contains(summary.chat.id)
                                )
                            }
                            .buttonStyle(.plain)
                            .simultaneousGesture(TapGesture().onEnded { Haptics.selection() })
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                PinActionButton(
                                    chat: summary.chat,
                                    pinned: summary.pinned,
                                    session: session
                                )
                            }
                            .pinRowActions(for: summary, session: session) { chat in
                                if case let .room(room) = chat { groupProfile = room }
                            }
                        }
                    }
                    .padding(.bottom, 24)
                }
                .refreshable { await session.refresh() }
                .overlay {
                    if chats.isEmpty && pinnedChats.isEmpty && searchHits.isEmpty {
                        ContentUnavailableView(
                            query.isEmpty ? "No bots yet" : "Nothing matches",
                            systemImage: query.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                            description: Text(
                                query.isEmpty
                                    ? "Bots you create on your computer show up here."
                                    : "No chat matches \u{201C}\(query)\u{201D}."
                            )
                        )
                    }
                }
                // This is an inset, not an overlay: the roster's scrollable
                // content gains exactly the pill's height, so rows remain
                // visible while the activity details expand upward in place.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    HomeActivityPill(
                        open: { chat in path.append(chat) },
                        queuedReceipts: session.queueReceipts
                    )
                    .environmentObject(session)
                }
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: pinnedChats.map(\.id))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: pinnedShelfCollapseReserve)
            .onChange(of: pinnedChats.count) { oldCount, newCount in
                if newCount > 0 {
                    pinnedShelfCollapseReserve = true
                } else if oldCount > 0 {
                    pinnedShelfCollapseReserve = true
                    let delay = reduceMotion ? 0.0 : 0.28
                    Task {
                        try? await Task.sleep(for: .seconds(delay))
                        guard !Task.isCancelled, pinnedChats.isEmpty else { return }
                        pinnedShelfCollapseReserve = false
                    }
                }
            }
            // top-aligned: the roster fills downward from the header
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            // a bot that stopped for you grows out of the island
            .overlay(alignment: .top) {
                NeedsYouIsland(
                    update: session.state.updates.first { $0.kind == .needsYou },
                    hasIsland: IslandGeometry.hasIsland(topInset: geo.safeAreaInsets.top)
                ) { chat in
                    Haptics.selection()
                    path.append(chat)
                }
            }
            .accessibilityAction(named: "Show updates") {
                showingUpdates = true
            }
            }
            .background(VBotSurface.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
            .onChange(of: session.notificationChat) { _, chat in
                guard let chat else { return }
                path.append(chat)
                session.consumeNotificationChat()
            }
            .task {
                if let chat = session.notificationChat {
                    path.append(chat)
                    session.consumeNotificationChat()
                }
            }
#if DEBUG
            // `-store-preview -open-first`: land on the first chat, for the
            // screenshot harness and for looking at the chat screen without
            // a pairing. Combine with `-preview-bot=preview-parity
            // -preview-conversation -preview-not-following` for conversation
            // parity captures.
            .task {
                if ProcessInfo.processInfo.arguments.contains("-open-first"),
                   path.isEmpty {
                    let arguments = ProcessInfo.processInfo.arguments
                    let all = session.state.chatSummaries
                    if let spec = arguments.first(where: { $0.hasPrefix("-preview-bot=") }) {
                        let id = String(spec.dropFirst("-preview-bot=".count))
                        if let match = all.first(where: { $0.chat.id == id }) {
                            path.append(match.chat)
                            return
                        }
                    }
                    if let spec = arguments.first(where: { $0.hasPrefix("-open-group=") }) {
                        let id = String(spec.dropFirst("-open-group=".count))
                        if let room = session.state.rooms.first(where: { $0.id == id }) {
                            path.append(Chat.room(room))
                            return
                        }
                    }
                    if let first = chats.first {
                        path.append(first.chat)
                    }
                }
            }
#endif
            .sheet(isPresented: $showingUpdates) {
                UpdatesSheet(
                    open: { chat in
                        showingUpdates = false
                        path.append(chat)
                    },
                    queuedReceipts: session.queueReceipts
                )
            }
            .sheet(isPresented: $showingNewGroup) {
                NewGroupSheet { room in
                    showingNewGroup = false
                    path.append(Chat.room(room))
                }
            }
            .sheet(isPresented: $showingAccount) {
                AccountSheet()
                    .environmentObject(session)
            }
            .navigationDestination(item: $groupProfile) { room in
                GroupProfileView(room: room)
            }
            .task(id: query) {
                let expected = query
                guard expected.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
                    searchHits = []
                    searching = false
                    return
                }
                searching = true
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, query == expected else { return }
                searchHits = await session.search(expected)
                searching = false
            }
        }
    }

    // MARK: - Header

    /// The roster chrome follows the Grok Bot reference: your profile on the
    /// left and search/new-chat glass actions on the right. There is
    /// intentionally no centered title; the pinned faces and chat names
    /// provide the visual anchor instead.
    private var header: some View {
        Group {
            if searchOpen {
                HStack(spacing: 8) {
                    searchField
                    Button("Cancel") { closeSearch() }
                        .font(.body)
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, 4)
                        .frame(minHeight: 44)
                        .accessibilityLabel("Close search")
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    Button {
                        Haptics.selection()
                        showingAccount = true
                    } label: {
                        ZStack {
                            ProfileAvatar(
                                name: session.connection?.name ?? "You",
                                size: HomeRosterLayoutPolicy.profileDiameter
                            )
                            if session.connectionBanner.showsConnectingHalo {
                                ConnectionHalo(reduceMotion: reduceMotion)
                            }
                        }
                        .frame(
                            width: HomeRosterLayoutPolicy.profileTapDiameter,
                            height: HomeRosterLayoutPolicy.profileTapDiameter
                        )
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .glassCircle()
                    .accessibilityLabel("Account and settings")
                    .accessibilityValue(session.connectionBanner.accessibilityLabel)
                    .contextMenu {
                        if !session.state.updates.isEmpty {
                            Button {
                                showingUpdates = true
                            } label: {
                                Label("Show updates", systemImage: "bell.badge")
                            }
                        }
                    }

                    Spacer(minLength: 8)

                    GlassGroup(spacing: HomeRosterLayoutPolicy.chromeButtonGap) {
                        HStack(spacing: HomeRosterLayoutPolicy.chromeButtonGap) {
                            RosterHeaderButton(systemImage: "magnifyingglass", accessibilityLabel: "Search") {
                                withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) {
                                    searchOpen = true
                                }
                                searchFocused = true
                            }

                            Menu {
                                Button {
                                    Task {
                                        if let bot = await session.createBot() { path.append(Chat.bot(bot)) }
                                    }
                                } label: {
                                    Label("New bot", systemImage: "bubble.left.and.bubble.right")
                                }
                                Button {
                                    showingNewGroup = true
                                } label: {
                                    Label("New group", systemImage: "person.2")
                                }
                            } label: {
                                Image(systemName: "plus")
                                    .font(.system(
                                        size: HomeRosterLayoutPolicy.chromeButtonSymbolSize,
                                        weight: .medium
                                    ))
                                    .foregroundStyle(Color.primary)
                                    .frame(
                                        width: HomeRosterLayoutPolicy.chromeButtonDiameter,
                                        height: HomeRosterLayoutPolicy.chromeButtonDiameter
                                    )
                                    .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .glassCircle()
                            .accessibilityLabel("New conversation")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, HomeRosterLayoutPolicy.pagePadding)
        .padding(.top, HomeRosterLayoutPolicy.headerTopPadding)
        .padding(.bottom, searchOpen ? 8 : HomeRosterLayoutPolicy.headerBottomPadding)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: searchOpen)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.secondary)
            TextField("Search chats", text: $query)
                .font(.body)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .focused($searchFocused)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity)
        .frame(height: 44)
        .glassCapsule()
    }

    private func closeSearch() {
        query = ""
        searchFocused = false
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.24)) {
            searchOpen = false
        }
    }

    // MARK: - Data

    private var chats: [ChatSummary] {
        let all = session.state.chatSummaries
        guard !query.isEmpty else {
            // Pinned chats live in the hero shelf; the list below is one
            // unified stream of every remaining bot and room.
            return all.filter { !$0.pinned }
        }
        return all.filter {
            $0.chat.name.localizedCaseInsensitiveContains(query)
                || $0.chat.subtitle.localizedCaseInsensitiveContains(query)
                || $0.preview.localizedCaseInsensitiveContains(query)
        }
    }

    private var pinnedChats: [ChatSummary] {
        guard query.isEmpty else { return [] }
        return session.state.chatSummaries.filter(\.pinned)
    }

    private var waitingChats: Set<String> {
        Set(session.state.pendingApprovals.compactMap { session.state.chat(forThread: $0.threadId)?.id })
    }

    private func open(_ chat: Chat) {
        path.append(chat)
    }

}

/// A round glass action for the roster header. Same material as the rest of
/// the chrome so search and + read as one object with the profile tile.
private struct RosterHeaderButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(
                    size: HomeRosterLayoutPolicy.chromeButtonSymbolSize,
                    weight: .medium
                ))
                .foregroundStyle(Color.primary)
                .frame(
                    width: HomeRosterLayoutPolicy.chromeButtonDiameter,
                    height: HomeRosterLayoutPolicy.chromeButtonDiameter
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCircle()
        .accessibilityLabel(accessibilityLabel)
    }
}

/// A quiet connection indicator that keeps the initial connection state in
/// the profile control instead of adding a roster-shifting text banner.
private struct ConnectionHalo: View {
    let reduceMotion: Bool

    var body: some View {
        if reduceMotion {
            Circle()
                .stroke(Color.secondary.opacity(0.42), lineWidth: 1.5)
                .frame(width: 42, height: 42)
                .accessibilityHidden(true)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 1.4) / 1.4
                Circle()
                    .trim(from: 0.08, to: 0.72)
                    .stroke(
                        Color.secondary.opacity(0.50),
                        style: StrokeStyle(lineWidth: 1.5, lineCap: .round)
                    )
                    .frame(width: 42, height: 42)
                    .rotationEffect(.degrees(phase * 360))
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct PinActionButton: View {
    let chat: Chat
    let pinned: Bool
    @ObservedObject var session: Session

    private var pending: Bool {
        session.pendingPinnedChats.contains(chat.stableID)
    }

    var body: some View {
        Button {
            session.togglePinned(chat)
        } label: {
            Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
        }
        .tint(.accentColor)
        .disabled(pending)
    }
}

private struct ChatPinRowActions: ViewModifier {
    let chat: Chat
    let pinned: Bool
    @ObservedObject var session: Session
    let openGroup: (Chat) -> Void

    func body(content: Content) -> some View {
        content
            .contextMenu {
                if chat.unread {
                    Button {
                        Task { await session.markRead(chat) }
                    } label: {
                        Label("Mark Read", systemImage: "envelope.open")
                    }
                } else {
                    Button {
                        Task { await session.markUnread(chat) }
                    } label: {
                        Label("Mark Unread", systemImage: "envelope.badge")
                    }
                }

                if case let .bot(bot) = chat, bot.hidden != true {
                    Button {
                        Task { _ = await session.setBotHidden(bot, hidden: true) }
                    } label: {
                        Label("Hide Chat", systemImage: "eye.slash")
                    }
                }

                PinActionButton(chat: chat, pinned: pinned, session: session)

                if case .room = chat {
                    Button {
                        openGroup(chat)
                    } label: {
                        Label("Group Details", systemImage: "person.2")
                    }
                }

                Menu("More", systemImage: "ellipsis") {
                    Button {
                        UIPasteboard.general.string = chat.id
                    } label: {
                        Label("Copy ID", systemImage: "doc.on.doc")
                    }
                    Button(role: .destructive) {
                        session.actionError = "Delete this conversation from the computer."
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
    }
}

private extension View {
    func pinRowActions(
        for summary: ChatSummary,
        session: Session,
        openGroup: @escaping (Chat) -> Void = { _ in }
    ) -> some View {
        modifier(ChatPinRowActions(
            chat: summary.chat,
            pinned: summary.pinned,
            session: session,
            openGroup: openGroup
        ))
    }

}

// MARK: - Rows and tiles

/// The list avatar keeps rooms recognizable without giving them a generic
/// blue placeholder. A room's first three members are arranged like the
/// stacked faces in the roster; bots keep their own artwork and state.
private struct RosterChatAvatar: View {
    let chat: Chat
    let size: CGFloat
    let state: MausState
    let animated: Bool

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated)
        case let .room(room):
            RoomFaceStack(room: room, size: size, animated: animated)
        }
    }
}

struct ChatRow: View {
    let chat: Chat
    let preview: String
    let at: Double
    var state: MausState = .idle
    var waiting = false
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: HomeRosterLayoutPolicy.rowAvatarSpacing) {
            RosterChatAvatar(
                chat: chat,
                size: HomeRosterLayoutPolicy.rowAvatar,
                state: state,
                animated: !reduceMotion && state.showsActivity
            )

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(chat.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .layoutPriority(1)

                    Spacer(minLength: 6)

                    Text(RelativeStamp.list(at))
                        .font(.footnote)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .layoutPriority(0)
                }

                HStack(alignment: .top, spacing: 8) {
                    Text(preview.isEmpty ? " " : preview)
                        .font(.subheadline)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Spacer(minLength: 0)

                    if chat.busy {
                        ProgressView()
                            .controlSize(.mini)
                            .padding(.top, 2)
                    } else if chat.unread {
                        Circle()
                            .fill(VBotSurface.unread)
                            .frame(width: 10, height: 10)
                            .padding(.top, 4)
                            .accessibilityHidden(true)
                    }
                }

                if waiting {
                    Label("Waiting on you", systemImage: "hand.raised.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(VBotSurface.unread)
                        .lineLimit(1)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, HomeRosterLayoutPolicy.pagePadding)
        .padding(.vertical, HomeRosterLayoutPolicy.rowVerticalPadding)
        .frame(minHeight: HomeRosterLayoutPolicy.rowMinHeight, alignment: .top)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(chat.name)
        .accessibilityValue(accessibilityValue)
    }

    private var accessibilityValue: String {
        if waiting { return "Waiting on you" }
        if chat.busy { return "Working" }
        if chat.unread { return "Unread" }
        return preview
    }
}

/// Connection state, shown only when it is not "fine".
struct StatusBanner: View {
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if session.connectionBanner.showsRosterText {
                switch session.connectionBanner.kind {
                case .hidden, .connecting:
                    EmptyView()
                case .reconnecting:
                    banner(session.connectionBanner, tint: .secondary)
                case .offline:
                    banner(session.connectionBanner, tint: .orange)
                case .unauthorized:
                    banner(session.connectionBanner, tint: .red)
                }
            } else {
                EmptyView()
            }
        }
        .animation(reduceMotion ? nil : .default, value: session.connectionBanner.kind)
    }

    private func banner(_ presentation: ConnectionResiliencePolicy.Banner, tint: Color) -> some View {
        Label(presentation.text, systemImage: presentation.systemImage)
            .font(.footnote)
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: VBotSurface.Hit.minimum)
            .glassCapsule(interactive: false)
            .padding(.bottom, 8)
            .accessibilityLabel(presentation.accessibilityLabel)
            .accessibilityAddTraits(.updatesFrequently)
    }
}

struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: hit.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(Color.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.secondary.opacity(0.13)))

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.name).font(.system(size: 15, weight: .semibold))
                    if let task = hit.task, !task.isEmpty {
                        Text(task).font(.system(size: 12)).foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text(RelativeStamp.list(hit.at))
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
                Text(hit.snippet)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// Timestamps the way a messaging app writes them.
enum RelativeStamp {
    /// Roster: time today, weekday this week, date beyond that.
    static func list(_ at: Double) -> String {
        guard at > 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// In a transcript: enough to place a gap in the conversation.
    static func separator(_ date: Date) -> String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "Today \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        return "\(date.formatted(.dateTime.day().month(.abbreviated))) \(time)"
    }
}
