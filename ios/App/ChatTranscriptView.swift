import CompanionCore
import SwiftUI
import UIKit

/// Transcript pane: settled rows, tool-run grouping, and the live tail.
struct ChatTranscriptView: View {
    let chat: Chat
    @Binding var followingLatest: Bool
    @Binding var lastDistanceFromBottom: CGFloat
    @Binding var viewportHeight: CGFloat
    @Binding var openedToolRuns: Set<String>
    @Binding var closedToolRuns: Set<String>
    @Binding var newAfterMessageId: String?
    @Binding var commRoom: Room?
    @Binding var replyingTo: Message?
    @FocusState.Binding var composerFocused: Bool
    @Binding var streamA11yPhase: StreamAccessibilityPhase
    let draftIsEmpty: Bool
    let onTranscriptChanged: ([Message]) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conversationTypography) private var chatTypography
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.reduced.rawValue
    @AppStorage(PrefKey.activityDetailOverrides) private var activityDetailOverrides = "{}"

    @State private var lastAnnouncedSettledId: String?

    static let liveBubbleId = "companion.live"

    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    private var threadId: String { current.threadId }

    private var messages: [Message] {
        session.state.visibleTranscript(forThread: threadId)
    }

    private var renderedMessages: [Message] {
        if effectiveActivityDetail == .hidden {
            return messages.filter { $0.kind != .activity }
        }
        return messages
    }

    private var effectiveActivityDetail: ActivityDetail {
        ActivityDetailOverrides.detail(for: threadId, in: activityDetailOverrides)
            ?? ActivityDetail(rawValue: activityDetail)
            ?? .reduced
    }

    private var liveTail: LiveTailKind {
        session.state.liveTailPresentation(forThread: threadId)
    }

    private var showsWorkingRow: Bool {
        switch liveTail {
        case .working, .streaming:
            return true
        case .none:
            return false
        }
    }

    private var streamingSpeakerName: String? {
        guard case let .room(room) = current,
              let botId = room.busyBotId,
              let bot = session.state.bot(botId)
        else { return nil }
        return bot.name
    }

    private var streamingAccessibilityLabel: String {
        let name = streamingSpeakerName ?? current.name
        return "\(name) is working"
    }

    private var workingBotId: String? {
        switch current {
        case let .bot(bot): return bot.id
        case let .room(room): return room.busyBotId
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            GeometryReader { pane in
                ZStack(alignment: .bottom) {
                    applyingTranscriptScrollEffects(
                        to: transcriptScrollView(proxy: proxy, paneWidth: pane.size.width),
                        proxy: proxy
                    )

                    transcriptAdornments(proxy: proxy, paneWidth: pane.size.width)
                }
            }
        }
        .id(threadId)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func transcriptAdornments(proxy: ScrollViewProxy, paneWidth: CGFloat) -> some View {
        let showsScroll = ConversationLayoutPolicy.showsScrollToBottomButton(
            followingLatest: followingLatest,
            hasTranscript: !messages.isEmpty
        )
        let showsFloating = ConversationLayoutPolicy.showsFloatingWorkingAvatar(
            showsWorkingRow: showsWorkingRow,
            followingLatest: followingLatest
        )
        if showsScroll || showsFloating {
            HStack(alignment: .bottom, spacing: 12) {
                if showsFloating {
                    Button {
                        followingLatest = true
                        scrollToLatest(proxy)
                    } label: {
                        Group {
                            if let bot = floatingWorkingBot {
                                BotAvatarView(
                                    bot: bot,
                                    size: ConversationLayoutPolicy.floatingWorkingAvatarSize,
                                    state: .working,
                                    animated: !reduceMotion
                                )
                            } else {
                                ChatAvatarView(
                                    chat: current,
                                    size: ConversationLayoutPolicy.floatingWorkingAvatarSize,
                                    state: .working,
                                    animated: !reduceMotion
                                )
                            }
                        }
                        .frame(
                            width: ConversationLayoutPolicy.floatingWorkingAvatarSize,
                            height: ConversationLayoutPolicy.floatingWorkingAvatarSize
                        )
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(streamingAccessibilityLabel)
                }

                Spacer(minLength: 0)

                if showsScroll {
                    Button {
                        Haptics.selection()
                        followingLatest = true
                        scrollToLatest(proxy)
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .frame(
                                width: ConversationLayoutPolicy.floatingScrollButtonSize,
                                height: ConversationLayoutPolicy.floatingScrollButtonSize
                            )
                            .background(VBotSurface.controlSurface, in: Circle())
                            .overlay {
                                Circle()
                                    .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                            }
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Scroll to latest messages")
                }
            }
            .padding(.horizontal, ConversationLayoutPolicy.transcriptHorizontalMargin)
            .padding(.bottom, ConversationLayoutPolicy.floatingAdornmentBottomPadding)
        }
    }

    private var floatingWorkingBot: Bot? {
        if let speakerBotId = workingBotId { return session.state.bot(speakerBotId) }
        if case let .bot(bot) = current { return bot }
        return nil
    }

    private func transcriptScrollView(proxy: ScrollViewProxy, paneWidth: CGFloat) -> some View {
        ScrollView {
            transcriptStack(proxy: proxy, paneWidth: paneWidth)
        }
        .contentMargins(.top, ConversationLayoutPolicy.scrollContentTopInset, for: .scrollContent)
        .scrollClipDisabled()
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.bottom)
        .modifier(ChatFollowMonitor(
            followingLatest: $followingLatest,
            lastDistanceFromBottom: $lastDistanceFromBottom,
            viewportHeight: $viewportHeight
        ))
    }

    private func transcriptStack(proxy: ScrollViewProxy, paneWidth: CGFloat) -> some View {
        let transcript = renderedMessages
        return VStack(alignment: .leading, spacing: ConversationLayoutPolicy.transcriptRowSpacing) {
            if session.state.hasMore[threadId] == true {
                Button("Load earlier messages") {
                    let anchor = transcript.first?.id
                    Task {
                        await session.loadOlder(threadId: threadId)
                        if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                    }
                }
                .font(.footnote)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }

            ForEach(transcriptRows(in: transcript)) { row in
                transcriptRow(row, in: transcript)
            }

            ChatLiveTail(
                showWorking: showsWorkingRow,
                accessibilityLabel: streamingAccessibilityLabel,
                chat: current,
                speakerBotId: workingBotId
            )
        }
        .background(alignment: .bottom) {
            ChatScrollOffsetReader()
        }
        .padding(.horizontal, ConversationLayoutPolicy.transcriptHorizontalMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.chatPaneWidth, paneWidth)
    }

    @ViewBuilder
    private func transcriptRow(_ row: ChatTranscriptRow, in transcript: [Message]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !row.isRedundantCommNarration,
               startsANewStretch(at: row.startIndex, in: transcript) {
                Text(RelativeStamp.separator(row.firstMessage.date))
                    .font(chatTypography.compact)
                    .foregroundStyle(Color.secondary.opacity(0.58))
                    .frame(maxWidth: .infinity)
                    .padding(.top, ConversationLayoutPolicy.dateSeparatorTopPadding)
                    .padding(.bottom, ConversationLayoutPolicy.dateSeparatorBottomPadding)
            }
            if showsNewDivider(before: row, in: transcript) {
                NewMessagesDivider()
            }
            switch row.segment {
            case .message(let message):
                if row.isRedundantCommNarration {
                    Color.clear
                        .frame(width: 0, height: 0)
                        .accessibilityHidden(true)
                } else {
                    MessageRow(
                        chat: current,
                        message: message,
                        endsRun: endsRun(at: row.startIndex, in: transcript),
                        showsSpeaker: ChatPresentationPolicy.showsBubbleSpeakerAttribution(
                            isRoom: !current.isBot,
                            startsSpeakerRun: message.role != .user
                                && startsSpeakerRun(at: row.startIndex, in: transcript)
                        ),
                        onOpenComm: { groupId in
                            commRoom = session.state.rooms.first { $0.id == groupId }
                        },
                        onReply: { message in
                            replyingTo = message
                            composerFocused = true
                        }
                    )
                }
            case .toolRun(let run):
                ToolRunDisclosure(
                    run: run,
                    isExpanded: ToolRunGrouping.isExpanded(
                        run,
                        opened: openedToolRuns,
                        closed: closedToolRuns
                    ),
                    onToggle: { toggleToolRun(run) }
                )
            }
        }
        .id(row.id)
        .overlay(alignment: .top) {
            if case .toolRun(let run) = row.segment {
                VStack(spacing: 0) {
                    ForEach(Array(run.messageIds.dropFirst()), id: \.self) { id in
                        Color.clear
                            .frame(height: 1)
                            .id(id)
                    }
                }
                .frame(maxHeight: 1, alignment: .top)
                .accessibilityHidden(true)
                .allowsHitTesting(false)
            }
        }
    }

    private func applyingTranscriptScrollEffects<Content: View>(
        to content: Content,
        proxy: ScrollViewProxy
    ) -> some View {
        applyingTranscriptFocusEffects(
            to: applyingTranscriptFollowEffects(to: content, proxy: proxy),
            proxy: proxy
        )
    }

    private func applyingTranscriptFollowEffects<Content: View>(
        to content: Content,
        proxy: ScrollViewProxy
    ) -> some View {
        content
            .onChange(of: messages.last?.id) { _, _ in
                onTranscriptChanged(messages)
                guard let last = messages.last else { return }
                if last.role != .user, last.kind == .text || last.kind == .options {
                    SoundEffects.playReceived()
                    Haptics.impact(.light)
                }
                scrollToLatest(proxy)
            }
            .onChange(of: messages.last?.text) { _, _ in
                scrollToLatest(proxy, animated: false)
            }
            .onChange(of: showsWorkingRow) { _, _ in
                scrollToLatest(proxy, animated: false)
            }
            .onChange(of: current.busy) { _, _ in
                scrollToLatest(proxy)
            }
            .onChange(of: threadId) { _, _ in
                followingLatest = true
                lastDistanceFromBottom = 0
                streamA11yPhase = .idle
                lastAnnouncedSettledId = messages.last(where: { $0.role == .bot && $0.kind == .text })?.id
            }
            .onAppear {
                if lastAnnouncedSettledId == nil {
                    lastAnnouncedSettledId = messages.last(where: { $0.role == .bot && $0.kind == .text })?.id
                }
#if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-preview-not-following") {
                    followingLatest = false
                }
#endif
                announceStreamPhase()
                scrollToLatest(proxy)
            }
            .onChange(of: liveTail) { _, _ in
                announceStreamPhase()
            }
    }

    private func applyingTranscriptFocusEffects<Content: View>(
        to content: Content,
        proxy: ScrollViewProxy
    ) -> some View {
        content
            .onChange(of: composerFocused) { _, _ in
                scrollToLatest(proxy)
            }
            .onChange(of: draftIsEmpty) { _, _ in
                scrollToLatest(proxy)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { _ in
                scrollToLatest(proxy, animated: false)
            }
            .onChange(of: session.focusedMessageId) { _, messageId in
                guard let messageId,
                      messages.contains(where: { $0.id == messageId })
                else { return }
                if reduceMotion {
                    proxy.scrollTo(messageId, anchor: .center)
                } else {
                    withAnimation { proxy.scrollTo(messageId, anchor: .center) }
                }
                session.consumeFocus(messageId)
            }
            .task {
                guard let messageId = session.focusedMessageId,
                      messages.contains(where: { $0.id == messageId })
                else { return }
                proxy.scrollTo(messageId, anchor: .center)
                session.consumeFocus(messageId)
            }
#if DEBUG
            .task(id: "\(threadId)|preview-not-following") {
                guard ProcessInfo.processInfo.arguments.contains("-preview-not-following"),
                      messages.contains(where: { $0.id == "parity-bot-final" })
                else { return }
                followingLatest = false
                try? await Task.sleep(nanoseconds: 320_000_000)
                proxy.scrollTo("parity-bot-final", anchor: .bottom)
                try? await Task.sleep(nanoseconds: 120_000_000)
                followingLatest = false
            }
#endif
    }

    private func transcriptRows(in messages: [Message]) -> [ChatTranscriptRow] {
        var startIndex = 0
        let detail = effectiveActivityDetail
        let segments: [TranscriptSegment]
        if detail == .full {
            segments = messages.map(TranscriptSegment.message)
        } else {
            segments = ToolRunGrouping.segments(in: messages)
        }
        return segments.map { segment in
            let isRedundantCommNarration: Bool
            if case .message(let message) = segment {
                isRedundantCommNarration = CommActivityPresentation.shouldSuppressNarration(
                    message,
                    in: messages,
                    at: startIndex
                )
            } else {
                isRedundantCommNarration = false
            }
            let row = ChatTranscriptRow(
                segment: segment,
                startIndex: startIndex,
                isRedundantCommNarration: isRedundantCommNarration
            )
            startIndex += row.messageCount
            return row
        }
    }

    private func toggleToolRun(_ run: ToolRun) {
        Haptics.selection()
        let updates = {
            let expanded = ToolRunGrouping.isExpanded(
                run,
                opened: openedToolRuns,
                closed: closedToolRuns
            )
            if expanded {
                openedToolRuns.remove(run.id)
                closedToolRuns.insert(run.id)
            } else {
                closedToolRuns.remove(run.id)
                openedToolRuns.insert(run.id)
            }
        }
        if reduceMotion {
            updates()
        } else {
            withAnimation(.easeInOut(duration: 0.22), updates)
        }
    }

    private func startsANewStretch(at index: Int, in messages: [Message]) -> Bool {
        guard index > 0 else { return true }
        return messages[index].at - messages[index - 1].at > 30 * 60 * 1000
    }

    private func startsSpeakerRun(at index: Int, in messages: [Message]) -> Bool {
        guard index > 0 else { return true }
        let this = messages[index], prev = messages[index - 1]
        if this.role != prev.role { return true }
        if this.from?.botId != prev.from?.botId { return true }
        return prev.kind != .text || this.kind != .text
    }

    private func showsNewDivider(before row: ChatTranscriptRow, in messages: [Message]) -> Bool {
        guard let newAfterMessageId,
              let newIndex = messages.firstIndex(where: { $0.id == newAfterMessageId })
        else { return false }
        return row.startIndex == newIndex + 1
    }

    private func endsRun(at index: Int, in messages: [Message]) -> Bool {
        guard index + 1 < messages.count else { return true }
        let this = messages[index], next = messages[index + 1]
        if this.role != next.role { return true }
        if this.from?.name != next.from?.name { return true }
        return next.kind != .text
    }

    private func announceStreamPhase() {
        let next = StreamAccessibility.phase(for: liveTail)
        let last = messages.last
        let isSettling = (streamA11yPhase == .working || streamA11yPhase == .streaming)
            && (next == .idle || next == .complete)
        let newlySettled: String?
        if isSettling,
           let last, last.role == .bot, last.kind == .text,
           last.id != lastAnnouncedSettledId {
            newlySettled = last.text
        } else {
            newlySettled = nil
        }
        let announcement = StreamAccessibility.announcement(
            from: streamA11yPhase,
            to: next,
            speaker: streamingSpeakerName ?? current.name,
            settledReply: newlySettled
        )
        streamA11yPhase = next
        if newlySettled != nil, let id = last?.id {
            lastAnnouncedSettledId = id
        }
        guard let announcement else { return }
        UIAccessibility.post(notification: .announcement, argument: announcement)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard ChatFollow.shouldScrollToLatest(following: followingLatest) else { return }
        let target: String
        if showsWorkingRow {
            target = Self.liveBubbleId
        } else if let last = messages.last {
            target = last.id
        } else {
            return
        }
        func scroll(_ proxy: ScrollViewProxy) {
            if reduceMotion || !animated {
                proxy.scrollTo(target, anchor: .bottom)
            } else {
                withAnimation { proxy.scrollTo(target, anchor: .bottom) }
            }
        }
        Task { @MainActor in
            scroll(proxy)
            try? await Task.sleep(nanoseconds: 50_000_000)
            scroll(proxy)
            try? await Task.sleep(nanoseconds: 120_000_000)
            scroll(proxy)
        }
    }
}

private struct ChatTranscriptRow: Identifiable {
    let segment: TranscriptSegment
    let startIndex: Int
    let isRedundantCommNarration: Bool

    var id: String { segment.id }

    var messageCount: Int { segment.messageIds.count }

    var firstMessage: Message {
        switch segment {
        case .message(let message):
            return message
        case .toolRun(let run):
            return run.messages[0]
        }
    }
}

/// Working indicator. Partial assistant prose is never painted here; the
/// settled transcript row is the answer.
private struct ChatLiveTail: View {
    let showWorking: Bool
    let accessibilityLabel: String
    let chat: Chat
    let speakerBotId: String?

    var body: some View {
        if showWorking {
            WorkingTypingIndicatorView(
                chat: chat,
                speakerBotId: speakerBotId
            )
            .id(ChatTranscriptView.liveBubbleId)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
        }
    }
}

private struct ChatFollowMonitor: ViewModifier {
    @Binding var followingLatest: Bool
    @Binding var lastDistanceFromBottom: CGFloat
    @Binding var viewportHeight: CGFloat

    func body(content: Content) -> some View {
        content
            .coordinateSpace(name: "chat-scroll")
            .background { ChatViewportHeightReader() }
            .onPreferenceChange(ChatViewportHeightKey.self) { height in
                viewportHeight = height
            }
            .onPreferenceChange(ChatContentMaxYKey.self) { maxY in
                guard viewportHeight > 1 else { return }
                let distance = max(0, maxY - viewportHeight)
                followingLatest = ChatFollow.updatedFollowing(
                    following: followingLatest,
                    previousDistanceFromBottom: lastDistanceFromBottom,
                    distanceFromBottom: distance
                )
                lastDistanceFromBottom = distance
            }
    }
}

private struct ChatContentMaxYKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct ChatViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct ChatViewportHeightReader: View {
    var body: some View {
        GeometryReader { viewport in
            Color.clear.preference(
                key: ChatViewportHeightKey.self,
                value: viewport.size.height
            )
        }
    }
}

private struct ChatScrollOffsetReader: View {
    var body: some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: ChatContentMaxYKey.self,
                value: geo.frame(in: .named("chat-scroll")).maxY
            )
        }
        .frame(height: 0)
        .accessibilityHidden(true)
    }
}

private struct NewMessagesDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(VBotSurface.unread)
                .frame(height: 1)
            Text("NEW")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(VBotSurface.unread)
            Rectangle()
                .fill(VBotSurface.unread)
                .frame(height: 1)
        }
        .padding(.vertical, 6)
        .accessibilityLabel("New messages")
    }
}
