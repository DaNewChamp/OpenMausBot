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

    private var liveTail: LiveTailKind {
        session.state.liveTailPresentation(forThread: threadId)
    }

    private var presentedLiveText: String? {
        if case let .streaming(text) = liveTail { return text }
        return nil
    }

    private var showsWorkingRow: Bool {
        if case .working = liveTail { return true }
        return false
    }

    private var streamingSpeaker: (name: String, color: String)? {
        guard case let .room(room) = current,
              let botId = room.busyBotId,
              let bot = session.state.bot(botId)
        else { return nil }
        return (bot.name, bot.color)
    }

    private var streamingAccessibilityLabel: String {
        let name = streamingSpeaker?.name ?? current.name
        if presentedLiveText?.isEmpty == false {
            return "\(name) is writing"
        }
        return "\(name) is working"
    }

    private var streamingTintColor: String {
        streamingSpeaker?.color ?? current.color
    }

    private var workingBotId: String? {
        switch current {
        case let .bot(bot): return bot.id
        case let .room(room): return room.busyBotId
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            applyingTranscriptScrollEffects(
                to: transcriptScrollView(proxy: proxy),
                proxy: proxy
            )
        }
        .id(threadId)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func transcriptScrollView(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            transcriptStack(proxy: proxy)
        }
        .contentMargins(.top, 56, for: .scrollContent)
        .scrollClipDisabled()
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.bottom)
        .modifier(ChatFollowMonitor(
            followingLatest: $followingLatest,
            lastDistanceFromBottom: $lastDistanceFromBottom,
            viewportHeight: $viewportHeight
        ))
    }

    private func transcriptStack(proxy: ScrollViewProxy) -> some View {
        let transcript = messages
        return VStack(alignment: .leading, spacing: 10) {
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
                liveText: presentedLiveText,
                showWorking: showsWorkingRow,
                tintColor: streamingTintColor,
                speaker: streamingSpeaker,
                reduceMotion: reduceMotion,
                accessibilityLabel: streamingAccessibilityLabel,
                chat: current,
                speakerBotId: workingBotId
            )
        }
        .background(alignment: .bottom) {
            ChatScrollOffsetReader()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                    .padding(.top, 14)
                    .padding(.bottom, 6)
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
                        showsSpeaker: message.role != .user
                            && startsSpeakerRun(at: row.startIndex, in: transcript),
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
            .onChange(of: presentedLiveText?.count ?? 0) { _, length in
                guard length > 0 else { return }
                scrollToLatest(proxy, animated: false)
            }
            .onChange(of: current.busy) { _, _ in
                announceStreamPhase()
                scrollToLatest(proxy)
            }
            .onChange(of: threadId) { _, _ in
                followingLatest = true
                lastDistanceFromBottom = 0
                streamA11yPhase = .idle
            }
            .onAppear { announceStreamPhase() }
            .onChange(of: presentedLiveText) { _, _ in
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
    }

    private func transcriptRows(in messages: [Message]) -> [ChatTranscriptRow] {
        var startIndex = 0
        return ToolRunGrouping.segments(in: messages).map { segment in
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
        let next = StreamAccessibility.phase(
            isBusy: showsWorkingRow,
            hasVisibleText: presentedLiveText?.isEmpty == false
        )
        let announcement = StreamAccessibility.announcement(
            from: streamA11yPhase,
            to: next,
            speaker: streamingSpeaker?.name ?? current.name
        )
        streamA11yPhase = next
        guard let announcement else { return }
        UIAccessibility.post(notification: .announcement, argument: announcement)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard ChatFollow.shouldScrollToLatest(following: followingLatest) else { return }
        let streaming = presentedLiveText ?? ""
        let target: String
        if showsWorkingRow || !streaming.isEmpty {
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

/// Live reply vs working indicator. Own typed body so the transcript
/// stack does not type-check this branch together with every message row.
private struct ChatLiveTail: View {
    let liveText: String?
    let showWorking: Bool
    let tintColor: String
    let speaker: (name: String, color: String)?
    let reduceMotion: Bool
    let accessibilityLabel: String
    let chat: Chat
    let speakerBotId: String?

    var body: some View {
        if let live = liveText, !live.isEmpty {
            StreamingBubble(
                text: live,
                color: tintColor,
                speaker: speaker,
                reduceMotion: reduceMotion
            )
            .id(ChatTranscriptView.liveBubbleId)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
        } else if showWorking {
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
