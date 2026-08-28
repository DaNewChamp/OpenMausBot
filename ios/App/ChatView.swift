// One conversation: the transcript, the approval cards, and the composer.
//
// The transcript is whatever the harness folded — settled text, tool chips,
// option cards, screenshots. This renders those and nothing else; it does
// not re-derive anything from provider events, because the server already
// did that and having two folds is how two clients start disagreeing.
// Consecutive tool chips are grouped only for layout: one disclosure, every
// message id still a scroll target so search lands on the same chip.
import SwiftUI
import CompanionCore
// Unconditional, because the uses below are: `Color(uiColor:)` and
// `UIImage(data:)` are reached on every path through this file. A
// `canImport` guard around the import alone does not make the file portable
// — it only moves the failure from "no such module" to "no such type", and
// hides that this view is iOS-only behind something that looks like it
// isn't. The App target is iOS; CompanionCore is where the portable half
// lives.
import UIKit
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers

struct ChatView: View {
    let chat: Chat
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("conversationTextSize") private var conversationTextSize = ConversationTextSize.standard.rawValue
    @AppStorage("busySendDefault") private var busySendDefault = BusySendDefault.steer.rawValue
    @State private var draft = ""
    @State private var composerRequestGate = ComposerRequestGate()
    @State private var pendingQueueNotices: [String: PendingQueueNotice] = [:]
    @State private var showingTasks = false
    @State private var showingComputer = false
    @State private var showingPlus = false
    @State private var showingProfile = false
    @State private var showCommandHUD = false
    @State private var shareFile: ShareFile?
    @State private var commRoom: Room?
    @State private var groupProfileRoom: Room?
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = SpeechDictation()
    /// Manual disclosure state, keyed by the run's first message id. Failures
    /// open on their own; a tap here is what keeps a success open or a
    /// failure shut after later chips land on the same run.
    @State private var openedToolRuns: Set<String> = []
    @State private var closedToolRuns: Set<String> = []
    /// Images remain in local state until their message is acknowledged. A
    /// failed upload therefore leaves the preview and draft intact rather
    /// than turning a tap on Send into data loss.
    @State private var selectedAttachments: [PendingImageAttachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showingFileImporter = false
    @State private var showingCamera = false
    @State private var isUploadingAttachments = false
    @State private var attachmentError: String?
    @State private var pinPrompt: PendingPinChange?

    /// The live bubble's scroll target. A constant because there is at most
    /// one per chat and it has no message id to borrow.
    static let liveBubbleId = "companion.live"

    /// The live chat record, so busy/unread stay current as frames land.
    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    /// A bot receives a new thread when its task changes. Navigation keeps
    /// the original Chat value, so every transcript lookup must follow the
    /// live record instead of the snapshot that opened this screen.
    private var threadId: String { current.threadId }

    private var messages: [Message] {
        session.state.visibleTranscript(forThread: threadId)
    }

    /// Unread elsewhere — what the back pill's badge counts, like Messages.
    private var unreadElsewhere: Int {
        let mine = current.unread ? 1 : 0
        return max(0, session.state.unreadCount - mine)
    }

    var body: some View {
        // Read the transcript once for this render. Pagination changes the
        // array as a unit; repeatedly reaching through ObservableObject for
        // every row only recomputes the same value.
        let transcript = messages
        // Full-height stack, then composer as a bottom safe-area inset.
        // Putting the inset on the ScrollView itself sized the transcript
        // to its content, so a short chat left the composer floating in the
        // middle. The outer frame is forced to fill, then the inset shrinks
        // it for the composer *and* the keyboard. `.ignoresSafeArea()` on
        // the canvas must stay `.container` so it never eats the keyboard.
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    // VStack, not LazyVStack. A lazy stack does not know how
                    // tall it is until its rows have been built, so
                    // `.defaultScrollAnchor(.bottom)` anchors against an
                    // estimate and the chat opens somewhere in the middle of
                    // the conversation. Building all of it up front makes the
                    // height exact and the anchor land on the newest message.
                    // A thread holds 50 messages until you ask for more, so
                    // there is nothing here worth being lazy about.
                    VStack(alignment: .leading, spacing: 14) {
                        if session.state.hasMore[threadId] == true {
                            Button("Load earlier messages") {
                                // keep the reader where they were: after older
                                // messages are prepended, sit back on the one
                                // that used to be at the top
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
                            VStack(alignment: .leading, spacing: 6) {
                                // a gap in time is worth marking; a timestamp
                                // on every message is just noise
                                if !row.isRedundantCommNarration,
                                   startsANewStretch(at: row.startIndex, in: transcript) {
                                    Text(RelativeStamp.separator(row.firstMessage.date))
                                        .font(chatTypography.compact)
                                        .foregroundStyle(Color.secondary.opacity(0.58))
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 14)
                                        .padding(.bottom, 6)
                                }
                                switch row.segment {
                                case .message(let message):
                                    if row.isRedundantCommNarration {
                                        // Keep the persisted message and its
                                        // scroll identity, but let the comm
                                        // activity row carry the visible and
                                        // accessible handoff affordance.
                                        Color.clear
                                            .frame(width: 0, height: 0)
                                            .accessibilityHidden(true)
                                    } else {
                                        MessageRow(
                                            chat: current,
                                            message: message,
                                            endsRun: endsRun(at: row.startIndex, in: transcript),
                                            onOpenComm: { groupId in
                                                commRoom = session.state.rooms.first { $0.id == groupId }
                                            },
                                            onReply: { _ in
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
                                // Extra ids for chips absorbed into the run.
                                // The first id is the row itself, so search
                                // to any step still lands on this disclosure.
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

                        // The reply as it is typed. It sits after the last
                        // settled message and disappears the moment the real
                        // one arrives — the store clears it on the same frame
                        // that appends the message, so there is never a beat
                        // where both are on screen.
                        if let live = session.state.streaming[threadId], !live.isEmpty {
                            StreamingBubble(
                                text: live,
                                reasoning: nil,
                                color: streamingTintColor,
                                speaker: streamingSpeaker
                            )
                                .id(Self.liveBubbleId)
                        } else if let thinking = session.state.reasoning[threadId], !thinking.isEmpty {
                            // Only while there is no answer yet. Once tokens
                            // of the reply exist, the reasoning is behind us
                            // and showing both is just noise.
                            StreamingBubble(
                                text: nil,
                                reasoning: thinking,
                                color: streamingTintColor,
                                speaker: streamingSpeaker
                            )
                                .id(Self.liveBubbleId)
                        } else if current.busy {
                            VStack(alignment: .leading, spacing: 4) {
                                if let speaker = streamingSpeaker {
                                    Text(speaker.name)
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(MausPalette.color(speaker.color))
                                }
                                TypingIndicatorView(tintColor: MausPalette.color(streamingTintColor))
                            }
                            .id(Self.liveBubbleId)
                            .accessibilityLabel(
                                streamingSpeaker.map { "\($0.name) is working" }
                                    ?? "\(current.name) is working"
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // A real safe-area inset keeps the transcript below the
                // compact bar. Nothing is overlaid on the first bubble, so
                // navigation transitions cannot leave a floating avatar
                // behind.
                .safeAreaInset(edge: .top, spacing: 0) { headerBar }
                .scrollDismissesKeyboard(.interactively)
                // A conversation grows from the bottom: a transcript shorter
                // than the screen rests at the bottom, and opening a chat
                // starts on the newest message rather than the oldest.
                .defaultScrollAnchor(.bottom)
                .onChange(of: transcript.last?.id) { _, _ in
                    reconcilePendingQueue(in: messages)
                    guard let last = transcript.last else { return }
                    if last.role != .user, last.kind == .text || last.kind == .options {
                        SoundEffects.playReceived()
                        Haptics.impact(.light)
                    }
                    if reduceMotion {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    } else {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
                // Follow the text as it arrives. Keyed on length rather than
                // the string so this fires once per delta batch, and without
                // animation — animating every token turns a smooth stream
                // into a stutter, because each scroll interrupts the last.
                .onChange(of: session.state.streaming[threadId]?.count ?? 0) { _, length in
                    guard length > 0 else { return }
                    proxy.scrollTo(Self.liveBubbleId, anchor: .bottom)
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
            .id(threadId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .overlay(alignment: .bottom) { plusSheet }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .background(VBotSurface.background.ignoresSafeArea(.container))
        .background {
            InteractivePopGestureEnabler()
                .frame(width: 0, height: 0)
        }
        .conversationTypography(ConversationTypography(
            size: selectedConversationTextSize,
            dynamicTypeSize: dynamicTypeSize
        ))
        .navigationDestination(isPresented: $showingComputer) {
            if case let .bot(bot) = current { ComputerView(bot: bot) }
        }
        .navigationDestination(item: $commRoom) { room in
            ChatView(chat: .room(room))
        }
        .navigationDestination(item: $groupProfileRoom) { room in
            GroupProfileView(room: room)
        }
        .pinConfirmationDialog($pinPrompt, session: session)
        .task(id: threadId) {
            // opening a chat is what marks it read, exactly as on the desktop
            if current.unread { await session.markRead(current) }
#if DEBUG
            // `-open-plus`: the + sheet up, for the screenshot harness
            if ProcessInfo.processInfo.arguments.contains("-open-plus") { showingPlus = true }
            // Profile parity screenshots without automating a tap through the
            // animated island/header transition.
            if ProcessInfo.processInfo.arguments.contains("-open-profile") { showingProfile = true }
            // `-open-computer` opens the watch-only panel for the preview
            // harness, so each deterministic computer state can be captured
            // without a paired computer or credentials.
            if ProcessInfo.processInfo.arguments.contains("-open-computer"), case .bot = current {
                showingComputer = true
            }
#endif
        }
        .task(id: "\(threadId)|reconstructed-activity") {
            guard case let .bot(bot) = current else { return }
            while !Task.isCancelled {
                await session.refreshReconstructedActivity(for: bot)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        .onChange(of: current.unread) { _, unread in
            // A message can arrive while this chat is already on screen. The
            // initial task above will not run again, so clear that new unread
            // bit here rather than leaving a badge on an open conversation.
            if unread { Task { await session.markRead(current) } }
        }
        .onChange(of: session.authoritativeHydrationRevision) { _, _ in
            // Only a completed full hydrate can retire notices that are no
            // longer represented by the server transcript. Resumed SSE
            // reconnects leave this revision alone, preserving local notices.
            reconcilePendingQueue(in: messages, authoritativeRefresh: true)
        }
        .onDisappear { dictation.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { dictation.stop() }
        }
        .onChange(of: showingComputer) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingTasks) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingProfile) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: groupProfileRoom) { _, room in
            if room != nil { dictation.stop() }
        }
        .onChange(of: showingPlus) { _, shown in
            if shown { dictation.stop() }
        }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
            let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt)
            if value == AVAudioSession.InterruptionType.began.rawValue {
                dictation.stop()
            }
        }
        .onChange(of: dictation.transcript) { _, spoken in
            // Always join against the text frozen at capture start. A newer
            // partial then replaces the older partial instead of duplicating it.
            draft = Dictation.draft(base: dictation.base, transcript: spoken)
        }
        .onChange(of: dictation.isListening) { _, listening in
            if listening { composerFocused = false }
        }
        .sheet(isPresented: $showingTasks) {
            if case let .bot(bot) = current { TaskManagerView(bot: bot) }
        }
        .sheet(isPresented: $showingProfile) {
            if case let .bot(bot) = current { AgentProfileView(bot: bot) }
        }
        .sheet(item: $shareFile) { file in
            ActivityShareSheet(items: [file.url])
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.image],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                Task { await importFiles(urls) }
            case let .failure(error):
                attachmentError = error.localizedDescription
            }
        }
        .sheet(isPresented: $showingCamera) {
            CameraAttachmentPicker { image in
                showingCamera = false
                addCameraImage(image)
            } onCancel: {
                showingCamera = false
            }
            .ignoresSafeArea()
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            setShowingPlus(false)
            Task { await importPhotos(items) }
        }
    }

    private var selectedConversationTextSize: ConversationTextSize {
        ConversationTextSize(rawValue: conversationTextSize) ?? .standard
    }

    private var chatTypography: ConversationTypography {
        ConversationTypography(size: selectedConversationTextSize, dynamicTypeSize: dynamicTypeSize)
    }

    // MARK: - Header

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
                        .frame(width: 44, height: 44)

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
                .frame(minWidth: 0, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(0)
            .contextMenu {
                Button {
                    pinPrompt = PendingPinChange(chat: current)
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

            if case .bot = current {
                Button {
                    Haptics.selection()
                    showingComputer = true
                } label: {
                    Image(systemName: "display")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCircle()
                .fixedSize()
                .accessibilityLabel("Watch \(current.name)'s computer")
            } else {
                Button {
                    Haptics.selection()
                    showingPlus = true
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCircle()
                .fixedSize()
                .accessibilityLabel("Open \(current.name) chat options")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(VBotSurface.background.ignoresSafeArea(.container, edges: .top))
    }

    // MARK: - The + sheet

    /// What the composer's + opens: a glass sheet of the things you can do
    /// here, each with a line saying what it does. Rises above the composer;
    /// tapping anywhere else, or the × the + became, puts it away.
    @ViewBuilder
    private var plusSheet: some View {
        if showingPlus {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .onTapGesture { setShowingPlus(false) }

                VStack(spacing: 0) {
                    attachmentPickerActions
                    Divider()
                        .padding(.horizontal, 18)
                    ForEach(plusActions) { action in
                        Button {
                            setShowingPlus(false)
                            action.run()
                        } label: {
                            HStack(spacing: 16) {
                                Image(systemName: action.systemImage)
                                    .font(.system(size: 20, weight: .medium))
                                    .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                    .frame(width: 44, height: 44)
                                    .background(Circle().fill(Color.primary.opacity(0.10)))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(action.title)
                                        .font(.system(size: 19, weight: .medium))
                                        .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                    Text(action.subtitle)
                                        .font(.system(size: 13))
                                        .foregroundStyle(Color.secondary)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 18)
                            .frame(height: 64)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(action.disabled)
                        .opacity(action.disabled ? 0.45 : 1)
                    }
                }
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassSheet(cornerRadius: 30)
                .padding(.leading, 12)
                .padding(.trailing, 44)
                .padding(.bottom, 70)
                .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
            }
            .transition(reduceMotion ? .identity : .opacity)
        }
    }

    @ViewBuilder
    private var attachmentPickerActions: some View {
        PhotosPicker(
            selection: $photoItems,
            maxSelectionCount: max(1, Self.maxAttachmentCount - selectedAttachments.count),
            matching: .images
        ) {
            HStack(spacing: 16) {
                Image(systemName: "photo.on.rectangle")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.primary.opacity(0.10)))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Photo library")
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(Color.primary)
                    Text("Choose images from Photos")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .frame(height: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(selectedAttachments.count >= Self.maxAttachmentCount)

        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button {
                setShowingPlus(false)
                showingCamera = true
            } label: {
                HStack(spacing: 16) {
                    Image(systemName: "camera")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(Color.primary.opacity(0.10)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Take photo")
                            .font(.system(size: 19, weight: .medium))
                            .foregroundStyle(Color.primary)
                        Text("Use the camera")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .frame(height: 64)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(selectedAttachments.count >= Self.maxAttachmentCount)
        }

        Button {
            setShowingPlus(false)
            showingFileImporter = true
        } label: {
            HStack(spacing: 16) {
                Image(systemName: "folder")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.primary.opacity(0.10)))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Choose file")
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(Color.primary)
                    Text("PNG, JPEG, GIF, or WebP up to 10 MB")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .frame(height: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(selectedAttachments.count >= Self.maxAttachmentCount)
    }

    private struct PlusAction: Identifiable {
        let id: String
        let systemImage: String
        let title: String
        let subtitle: String
        var destructive = false
        var disabled = false
        let run: () -> Void
    }

    private var plusActions: [PlusAction] {
        var out: [PlusAction] = []
        if case let .bot(bot) = current {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New task",
                subtitle: "Start a fresh thread with \(bot.name)", disabled: bot.busy == true
            ) { Task { await session.createTask(for: bot, title: nil) } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            out.append(PlusAction(
                id: "computer", systemImage: "display", title: "Watch computer",
                subtitle: "Live view of what \(bot.name) is doing"
            ) { showingComputer = true })
        }
        let pinned = current.pinned
        out.append(PlusAction(
            id: "pin",
            systemImage: pinned ? "pin.slash" : "pin",
            title: pinned ? "Unpin" : "Pin",
            subtitle: pinned ? "Remove from the home strip" : "Keep this chat on the home strip",
            disabled: session.pendingPinnedChats.contains(current.stableID)
        ) {
            pinPrompt = PendingPinChange(chat: current, pinned: pinned)
        })
        out.append(PlusAction(
            id: "share", systemImage: "doc.plaintext", title: "Share transcript",
            subtitle: "This chat as Markdown"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "markdown") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        out.append(PlusAction(
            id: "share-json", systemImage: "curlybraces", title: "Share as JSON",
            subtitle: "Structured transcript data"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "json") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        if current.busy, case let .bot(bot) = current {
            out.append(PlusAction(
                id: "stop", systemImage: "stop.fill", title: "Interrupt",
                subtitle: "Stop the current turn", destructive: true
            ) { Task { await session.interrupt(bot: bot) } })
        }
        return out
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
        updateState(.easeInOut(duration: 0.22)) {
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
    }

    private func setShowingPlus(_ value: Bool) {
        updateState(.snappy(duration: 0.28)) { showingPlus = value }
    }

    private func updateState(_ animation: Animation, _ updates: () -> Void) {
        if reduceMotion {
            updates()
        } else {
            withAnimation(animation, updates)
        }
    }

    // MARK: - Attachments

    private static let maxAttachmentCount = 10

    private func appendAttachment(data: Data, mime: String, name: String) {
        guard selectedAttachments.count < Self.maxAttachmentCount else {
            attachmentError = "You can attach up to (Self.maxAttachmentCount) images per message."
            return
        }
        do {
            try AttachmentPath.validate(data: data, mime: mime)
            let normalized = AttachmentPath.normalizedMIME(mime) ?? mime
            selectedAttachments.append(
                PendingImageAttachment(
                    data: data,
                    mime: normalized,
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Image" : name
                )
            )
            attachmentError = nil
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard selectedAttachments.count < Self.maxAttachmentCount else {
                attachmentError = "You can attach up to (Self.maxAttachmentCount) images per message."
                break
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    throw APIError.transport("That photo could not be read.")
                }
                let suggested = item.supportedContentTypes.first?.preferredMIMEType
                guard let mime = Self.imageMIME(data, suggested: suggested) else {
                    throw APIError.transport("Choose a PNG, JPEG, GIF, or WebP image.")
                }
                appendAttachment(data: data, mime: mime, name: "Photo")
            } catch {
                attachmentError = error.localizedDescription
            }
        }
    }

    private func importFiles(_ urls: [URL]) async {
        for url in urls {
            guard selectedAttachments.count < Self.maxAttachmentCount else {
                attachmentError = "You can attach up to (Self.maxAttachmentCount) images per message."
                break
            }
            let accessed = url.startAccessingSecurityScopedResource()
            defer {
                if accessed { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url, options: [.mappedIfSafe])
                let suggested = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                guard let mime = Self.imageMIME(data, suggested: suggested) else {
                    throw APIError.transport("Choose a PNG, JPEG, GIF, or WebP image.")
                }
                appendAttachment(data: data, mime: mime, name: url.deletingPathExtension().lastPathComponent)
            } catch {
                attachmentError = "(url.lastPathComponent): (error.localizedDescription)"
            }
        }
    }

    private func addCameraImage(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            attachmentError = "That photo could not be read."
            return
        }
        appendAttachment(data: data, mime: "image/jpeg", name: "Camera photo")
    }

    private static func imageMIME(_ data: Data, suggested: String? = nil) -> String? {
        if data.count >= 8,
           data[data.startIndex] == 0x89,
           data[data.startIndex + 1] == 0x50,
           data[data.startIndex + 2] == 0x4E,
           data[data.startIndex + 3] == 0x47 {
            return "image/png"
        }
        if data.count >= 3,
           data[data.startIndex] == 0xFF,
           data[data.startIndex + 1] == 0xD8,
           data[data.startIndex + 2] == 0xFF {
            return "image/jpeg"
        }
        if data.count >= 4,
           String(data: data.prefix(4), encoding: .ascii) == "GIF8" {
            return "image/gif"
        }
        if data.count >= 12,
           String(data: data.prefix(4), encoding: .ascii) == "RIFF",
           String(data: data.dropFirst(8).prefix(4), encoding: .ascii) == "WEBP" {
            return "image/webp"
        }
        return AttachmentPath.normalizedMIME(suggested ?? "")
    }

    private func uploadSelectedAttachments() async -> [String]? {
        guard !selectedAttachments.isEmpty else { return [] }
        isUploadingAttachments = true
        defer { isUploadingAttachments = false }
        let ids = selectedAttachments.map(\.id)
        var paths: [String] = []
        for id in ids {
            guard let index = selectedAttachments.firstIndex(where: { $0.id == id }) else { continue }
            if let uploaded = selectedAttachments[index].uploaded {
                paths.append(uploaded.path)
                continue
            }
            do {
                let uploaded = try await session.uploadAttachment(
                    data: selectedAttachments[index].data,
                    mime: selectedAttachments[index].mime
                )
                guard let currentIndex = selectedAttachments.firstIndex(where: { $0.id == id }) else { continue }
                selectedAttachments[currentIndex].uploaded = uploaded
                selectedAttachments[currentIndex].error = nil
                paths.append(uploaded.path)
            } catch {
                if let currentIndex = selectedAttachments.firstIndex(where: { $0.id == id }) {
                    selectedAttachments[currentIndex].error = error.localizedDescription
                }
                attachmentError = error.localizedDescription
                return nil
            }
        }
        return paths
    }

    private func removeAttachment(_ id: UUID) {
        guard !isUploadingAttachments else { return }
        selectedAttachments.removeAll { $0.id == id }
        if selectedAttachments.isEmpty { attachmentError = nil }
    }

    /// True when this message opens a fresh stretch of conversation — the
    /// first one, or one that follows a gap of half an hour or more.
    private func startsANewStretch(at index: Int, in messages: [Message]) -> Bool {
        guard index > 0 else { return true }
        return messages[index].at - messages[index - 1].at > 30 * 60 * 1000
    }

    /// True when the next message is from someone else (or there is none),
    /// which is where a run of bubbles gets its tail — one per run, like
    /// every messaging app, rather than one per bubble.
    private func endsRun(at index: Int, in messages: [Message]) -> Bool {
        guard index + 1 < messages.count else { return true }
        let this = messages[index], next = messages[index + 1]
        if this.role != next.role { return true }
        if this.from?.name != next.from?.name { return true }
        // a card or a tool chip between two texts breaks the run visually
        return next.kind != .text
    }

    private var selectedBusySendDefault: BusySendDefault {
        BusySendDefault(rawValue: busySendDefault)
    }

    private var composerCapabilities: EngineComposerCapabilities {
        VBotMutationRouting.composerCapabilities(for: session.engineSync)
    }

    private var roomMembers: [GroupRouting.Member] {
        guard case let .room(room) = current else { return [] }
        return room.memberIds.compactMap { id in
            session.state.bot(id).map {
                GroupRouting.Member(id: $0.id, name: $0.name, hidden: $0.hidden == true, color: $0.color)
            }
        }
    }

    /// Rooms attribute streaming text to whoever owns the active turn.
    private var streamingSpeaker: (name: String, color: String)? {
        guard case let .room(room) = current,
              let botId = room.busyBotId,
              let bot = session.state.bot(botId)
        else { return nil }
        return (bot.name, bot.color)
    }

    private var streamingTintColor: String {
        streamingSpeaker?.color ?? current.color
    }

    private var activeMentionQuery: String? {
        guard case .room = current else { return nil }
        return GroupRouting.activeMentionQuery(in: draft)
    }

    private var mentionCandidates: [GroupRouting.Member] {
        guard let query = activeMentionQuery else { return [] }
        return GroupRouting.mentionCandidates(query: query, members: roomMembers)
    }

    private var composerPlaceholder: String {
        if dictation.isListening { return "Listening…" }
        if case let .room(room) = current {
            return GroupRouting.groupComposerHint(room: room, members: roomMembers)
        }
        return "Ask \(current.name)"
    }

    private func insertMention(_ name: String) {
        draft = GroupRouting.applyingMention(name, to: draft)
        Haptics.selection()
    }

    private var primaryAction: ComposerPrimaryAction {
        // The shared policy knows about text only. A selected image is still
        // a sendable message, so pass a non-empty sentinel without changing
        // the prompt that ultimately goes over the wire.
        let policyDraft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !selectedAttachments.isEmpty
            ? " "
            : draft
        return ComposerActionPolicy.action(
            busy: current.busy,
            draft: policyDraft,
            defaultMode: selectedBusySendDefault,
            capabilities: composerCapabilities
        )
    }

    private var canSend: Bool {
        if case .send = primaryAction { return true }
        return false
    }

    private var hasPendingApproval: Bool {
        messages.contains { $0.card?.isPending == true }
    }

    private func submit(
        _ explicitText: String? = nil,
        mode explicitMode: MessageDeliveryMode? = nil
    ) {
        // This also cancels an in-flight permission prompt before it can
        // open the microphone after the message has already been sent.
        dictation.stop()
        let draftAtSubmission = draft
        let text = (explicitText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !selectedAttachments.isEmpty), composerRequestGate.begin() else { return }
        let target = current
        let mode = explicitMode ?? (target.busy ? selectedBusySendDefault.deliveryMode : .auto)
        showCommandHUD = false
        Task { @MainActor in
            let prompt: String
            if selectedAttachments.isEmpty {
                prompt = text
            } else if let paths = await uploadSelectedAttachments() {
                prompt = AttachmentPrompt.compose(text: text, paths: paths)
            } else {
                composerRequestGate.end()
                return
            }
            let receipt = await session.send(prompt, to: target, mode: mode)
            if let receipt, receipt.ok {
                if let queueId = receipt.queueId {
                    pendingQueueNotices[queueId] = PendingQueueNotice(
                        queueId: queueId,
                        threadId: target.threadId
                    )
                    // The queued line may have landed on the transcript before
                    // the HTTP acknowledgement returned. Reconcile now as
                    // well as from the normal transcript-change path so that
                    // SSE-before-HTTP cannot leave a stale local notice.
                    reconcilePendingQueue(in: messages)
                }
                // The editor remains usable while the request is in flight.
                // Do not erase a newer draft that was typed after submission.
                if draft == draftAtSubmission { draft = "" }
                selectedAttachments.removeAll()
                attachmentError = nil
                SoundEffects.playSent()
                Haptics.impact(.medium)
            }
            composerRequestGate.end()
        }
    }

    private func activatePrimaryAction() {
        guard !composerRequestGate.isInFlight else { return }
        switch primaryAction {
        case .stop:
            let target = current
            guard composerRequestGate.begin() else { return }
            dictation.stop()
            Task { @MainActor in
                await session.interrupt(chat: target)
                composerRequestGate.end()
            }
        case .send(let mode):
            submit(mode: mode)
        case .none:
            break
        }
    }

    private func reconcilePendingQueue(in transcript: [Message], authoritativeRefresh: Bool = false) {
        guard !pendingQueueNotices.isEmpty else { return }
        if authoritativeRefresh {
            pendingQueueNotices = pendingQueueNotices.filter { _, pending in
                pending.threadId != threadId
            }
            return
        }
        let pendingForThread = pendingQueueNotices.values
            .filter { $0.threadId == threadId }
            .map(\.queueId)
        let remaining = PendingQueueReconciliation.remainingQueueIDs(
            pendingQueueIDs: pendingForThread,
            transcript: transcript
        )
        pendingQueueNotices = pendingQueueNotices.filter { _, pending in
            pending.threadId != threadId || remaining.contains(pending.queueId)
        }
    }

    // MARK: - Composer

    /// A round + and a glass pill with dictation and send inside it.
    private var composer: some View {
        VStack(spacing: 6) {
            let pendingCount = pendingQueueNotices.values.filter { $0.threadId == threadId }.count
            attachmentPreviewStrip

            if pendingCount > 0 {
                Label(
                    pendingCount == 1
                        ? "Queued · waiting for current work"
                        : "\(pendingCount) queued · waiting for current work",
                    systemImage: "clock.arrow.circlepath"
                )
                    .font(chatTypography.detail.weight(.medium))
                    .foregroundStyle(Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .accessibilityLabel("Message queued and waiting for current work")
            }

            if let error = dictation.error {
                Text(error)
                    .font(chatTypography.detail)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }

            if let attachmentError {
                Label(attachmentError, systemImage: "exclamationmark.triangle")
                    .font(chatTypography.detail)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .accessibilityLabel("Attachment error")
            }

            if let query = activeMentionQuery, case .room = current {
                MentionMenuView(
                    query: query,
                    members: mentionCandidates,
                    includeEveryone: "everyone".hasPrefix(query.lowercased()),
                    accentColor: MausPalette.color(current.color)
                ) { name in
                    insertMention(name)
                }
            } else if showCommandHUD {
                CommandSkillHUDView(
                    text: $draft,
                    isVisible: $showCommandHUD,
                    commands: current.isBot
                        ? CommandSkillHUDView.defaultCommands
                        : CommandSkillHUDView.defaultCommands.filter { $0.id != "computer" && $0.id != "tasks" },
                    accentColor: MausPalette.color(current.color)
                ) { command in
                    switch command.id {
                    case "computer":
                        draft = ""
                        showingComputer = true
                    case "tasks":
                        draft = ""
                        showingTasks = true
                    default: submit(command.command)
                    }
                }
                .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
            } else if draft.isEmpty && !current.busy && !hasPendingApproval {
                PredictiveActionChipsView(accentColor: MausPalette.color(current.color)) { chip in
                    submit(chip.prompt)
                }
                .transition(reduceMotion ? .identity : .opacity)
            }

            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    dictation.stop()
                    composerFocused = false
                    setShowingPlus(!showingPlus)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .rotationEffect(.degrees(showingPlus ? 45 : 0))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCircle()
                .accessibilityLabel(showingPlus ? "Close" : "More")

                HStack(alignment: .bottom, spacing: 2) {
                    if showCommandHUD || draft.hasPrefix("/") {
                        Button {
                            dictation.stop()
                            updateState(.spring(response: 0.3, dampingFraction: 0.75)) {
                                showCommandHUD.toggle()
                            }
                            Haptics.selection()
                        } label: {
                            Image(systemName: "command")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(showCommandHUD ? Color.primary : Color.secondary.opacity(0.72))
                                .frame(width: 27, height: 34)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Slash commands")
                        .padding(.leading, 5)
                    }

                    TextField(
                        composerPlaceholder,
                        text: $draft,
                        axis: .vertical
                    )
                        .lineLimit(1...5)
                        .font(chatTypography.composer)
                        .padding(.leading, showCommandHUD || draft.hasPrefix("/") ? 0 : 16)
                        .padding(.vertical, 12)
                        .focused($composerFocused)
                        .submitLabel(.send)
                        // Partial transcripts rebuild from a frozen base;
                        // prevent competing edits without dimming the text.
                        .allowsHitTesting(!dictation.isListening && !dictation.isStarting)
                        .onChange(of: draft) { _, value in
                            updateState(.easeInOut(duration: 0.15)) {
                                showCommandHUD = value.hasPrefix("/")
                            }
                        }
                        .onKeyPress(.return, phases: .down) { press in
                            guard !press.modifiers.contains(.shift) else { return .ignored }
                            activatePrimaryAction()
                            return .handled
                        }
                        .onSubmit { activatePrimaryAction() }

                    if primaryAction == .none || dictation.isListening {
                        Button {
                            composerFocused = false
                            dictation.toggle(capturing: draft)
                        } label: {
                            Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(dictation.isListening ? Color.red : Color.primary)
                                .frame(width: 36, height: 36)
                                .symbolEffect(.pulse, isActive: dictation.isListening && !reduceMotion)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 8)
                        .padding(.bottom, 4)
                        .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
                    } else {
                        primaryActionButton
                    }
                }
                .frame(minHeight: 48)
                .glassCapsule()
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(VBotSurface.background.ignoresSafeArea(.container, edges: .bottom))
    }

    @ViewBuilder
    private var attachmentPreviewStrip: some View {
        if !selectedAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(selectedAttachments) { attachment in
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if let image = UIImage(data: attachment.data) {
                                    Image(uiImage: image)
                                        .resizable()
                                        .scaledToFill()
                                } else {
                                    Image(systemName: "photo")
                                        .font(.system(size: 20, weight: .medium))
                                        .foregroundStyle(Color.secondary)
                                }
                            }
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                    .stroke(Color.primary.opacity(0.16), lineWidth: 1)
                            }

                            if isUploadingAttachments && attachment.uploaded == nil {
                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                    .fill(Color.black.opacity(0.35))
                                    .frame(width: 64, height: 64)
                                    .overlay { ProgressView().tint(.white) }
                            }

                            Button {
                                removeAttachment(attachment.id)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 22, height: 22)
                                    .background(Circle().fill(Color.black.opacity(0.68)))
                            }
                            .buttonStyle(.plain)
                            .disabled(isUploadingAttachments)
                            .accessibilityLabel("Remove (attachment.name)")
                        }
                        .accessibilityElement(children: .contain)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 3)
            }
            .frame(height: 74)
            .accessibilityLabel("Selected images")
        }
    }

    @ViewBuilder
    private var primaryActionButton: some View {
        switch primaryAction {
        case .stop:
            Button { activatePrimaryAction() } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.red))
            }
            .buttonStyle(.plain)
            .disabled(composerRequestGate.isInFlight)
            .padding(.trailing, 6)
            .padding(.bottom, 6)
            .accessibilityLabel(current.isBot ? "Stop current work" : "Stop active responder")
            .accessibilityHint(
                current.isBot
                    ? "Interrupts the active turn for this conversation"
                    : "Interrupts the active responder; queued messages remain"
            )

        case .send(let mode):
            Button { submit(mode: mode) } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.primary))
            }
            .buttonStyle(.plain)
            .disabled(composerRequestGate.isInFlight)
            .contextMenu {
                if composerCapabilities.steer {
                    Button {
                        submit(mode: .steer)
                    } label: {
                        Label("Steer now", systemImage: "arrow.turn.up.right")
                    }
                }
                if composerCapabilities.queueing {
                    Button {
                        submit(mode: .queue)
                    } label: {
                        Label("Queue after current work", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
            .padding(.trailing, 6)
            .padding(.bottom, 6)
            .accessibilityLabel(mode == .steer ? "Send and steer" : mode == .queue ? "Send and queue" : "Send")
            .accessibilityHint("Touch and hold for explicit steer or queue choices")
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: canSend)

        case .none:
            Button { activatePrimaryAction() } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.secondary.opacity(0.18)))
            }
            .buttonStyle(.plain)
            .disabled(true)
            .padding(.trailing, 6)
            .padding(.bottom, 6)
            .accessibilityLabel("Send")
        }
    }
}

private struct MentionMenuView: View {
    let query: String
    let members: [GroupRouting.Member]
    let includeEveryone: Bool
    let accentColor: Color
    let onPick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if includeEveryone {
                mentionRow(title: "@everyone", subtitle: "Every bot in this chat", color: accentColor) {
                    onPick("everyone")
                }
            }
            ForEach(members, id: \.id) { member in
                mentionRow(
                    title: member.name,
                    subtitle: "Bring \(member.name) in",
                    color: MausPalette.color(member.color)
                ) {
                    onPick(member.name)
                }
            }
            if members.isEmpty && !includeEveryone {
                Text("No matching bot")
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(VBotSurface.controlSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .accessibilityLabel("Mention a bot")
    }

    private func mentionRow(title: String, subtitle: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Circle()
                    .fill(color)
                    .frame(width: 28, height: 28)
                    .overlay {
                        Text(String(title.drop(while: { $0 == "@" }).prefix(1)).uppercased())
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(MausPalette.faceInk(""))
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title.hasPrefix("@") ? title : "@\(title)")
                        .font(.body.weight(.medium))
                        .foregroundStyle(color)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct MessageRow: View {
    let chat: Chat
    let message: Message
    /// Last bubble of a run from the same side: the one that gets the tail.
    var endsRun = true
    var onOpenComm: (String) -> Void = { _ in }
    var onReply: (Message) -> Void = { _ in }
    @EnvironmentObject private var session: Session
    @Environment(\.conversationTypography) private var typography
    @State private var editingText = ""
    @State private var showingEdit = false

    private static let reactionChoices = ["👍", "👎", "❤️", "😂", "🎉", "😮"]

    private var versions: [Message] {
        session.state.versions(of: message, inThread: chat.threadId)
    }

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
            content

            if let reactions = message.reactions, !reactions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(reactionGroups(reactions), id: \.emoji) { group in
                        Button("\(group.emoji) \(group.count)") {
                            Task { await session.react(to: message, in: chat.threadId, emoji: group.emoji) }
                        }
                        .font(typography.detail)
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(group.mine ? Color.accentColor : Color.secondary)
                    }
                }
            }

            if versions.count > 1, let index = versions.firstIndex(where: { $0.id == message.id }),
               case let .bot(bot) = chat {
                HStack(spacing: 8) {
                    Button {
                        Task { await session.switchVersion(to: versions[index - 1], for: bot) }
                    } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0 || bot.busy == true)
                    Text("\(index + 1) of \(versions.count)")
                    Button {
                        Task { await session.switchVersion(to: versions[index + 1], for: bot) }
                    } label: { Image(systemName: "chevron.right") }
                    .disabled(index + 1 >= versions.count || bot.busy == true)
                }
                .font(typography.compact)
                .foregroundStyle(Color.secondary)
            }
        }
        .contextMenu {
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) { Task { await session.react(to: message, in: chat.threadId, emoji: emoji) } }
            }
            if message.kind == .text, let text = message.text,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Divider()
                Button("Reply", systemImage: "arrowshape.turn.up.left") {
                    onReply(message)
                }
                Button("Copy", systemImage: "doc.on.doc") {
                    PlatformBridge.copyToPasteboard(text)
                }
            }
            if message.role == .user, message.kind == .text, case let .bot(bot) = chat {
                Divider()
                Button("Edit and retry", systemImage: "pencil") {
                    editingText = message.text ?? ""
                    showingEdit = true
                }
                .disabled(bot.busy == true)
            }
        }
        .alert("Edit and retry", isPresented: $showingEdit) {
            TextField("Message", text: $editingText)
            Button("Cancel", role: .cancel) {}
            if case let .bot(bot) = chat {
                Button("Send") {
                    let text = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await session.edit(message, for: bot, text: text) }
                }
            }
        } message: {
            Text("This creates a new version and continues from there.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch message.kind {
        case .text:
            TextBubble(message: message, chat: chat, tailed: endsRun)
        case .options:
            CardView(chat: chat, message: message)
        case .activity:
            let destinationAvailable = message.comm.map { comm in
                session.state.rooms.contains { $0.id == comm.groupId }
            } ?? false
            if let row = CommActivityPresentation(message: message, destinationAvailable: destinationAvailable), let comm = message.comm {
                CommActivityRow(presentation: row, comm: comm, onOpen: onOpenComm)
            } else {
                ActivityChip(tool: message.tool)
            }
        case .connector:
            if let connector = message.connector, connector.isUsable {
                ConnectorCardView(chat: chat, message: message, connector: connector)
            } else if let text = message.text, !text.isEmpty {
                TextBubble(message: message, chat: chat, tailed: endsRun)
            }
        case .screen:
            ScreenShot(threadId: chat.threadId, message: message)
        case .unknown:
            // A message kind from a newer computer. Almost everything the
            // harness sends carries `text`, so showing it is usually the
            // whole message and always better than a gap in the transcript.
            // When there is nothing to show, show nothing — a placeholder
            // saying "unsupported" is a worse gap than the gap.
            if let text = message.text, !text.isEmpty {
                TextBubble(message: message, chat: chat, tailed: endsRun)
            }
        }
    }

    private func reactionGroups(_ reactions: [Reaction]) -> [(emoji: String, count: Int, mine: Bool)] {
        Dictionary(grouping: reactions, by: \.emoji)
            .map { (emoji: $0.key, count: $0.value.count, mine: $0.value.contains { $0.by == "user" }) }
            .sorted { $0.emoji < $1.emoji }
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

private struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

private struct PendingImageAttachment: Identifiable, Equatable {
    let id: UUID
    let data: Data
    let mime: String
    let name: String
    var uploaded: UploadedAttachment?
    var error: String?

    init(data: Data, mime: String, name: String) {
        self.id = UUID()
        self.data = data
        self.mime = mime
        self.name = name
    }
}

private struct PendingQueueNotice: Equatable {
    let queueId: String
    let threadId: String
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct CameraAttachmentPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onImage: onImage, onCancel: onCancel) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage) -> Void
        let onCancel: () -> Void

        init(onImage: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onImage = onImage
            self.onCancel = onCancel
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage { onImage(image) }
            else { onCancel() }
        }
    }
}

struct TextBubble: View {
    let message: Message
    let chat: Chat
    var tailed = true
    @Environment(\.conversationTypography) private var typography
    @EnvironmentObject private var session: Session

    private var parsedAttachments: (display: String, paths: [String])? {
        guard message.role == .user, let text = message.text else { return nil }
        let parsed = AttachmentPrompt.split(text)
        return parsed.paths.isEmpty ? nil : parsed
    }

    private var parsedDiff: (filename: String, diff: String)? {
        guard message.role != .user, let source = message.text else { return nil }
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let diff: String
        if text.hasPrefix("```diff"), text.hasSuffix("```") {
            diff = String(text.dropFirst("```diff".count).dropLast(3))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } else if text.hasPrefix("diff --git ") {
            diff = text
        } else {
            return nil
        }
        let firstLine = diff.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        let filename = firstLine.split(separator: " ").last.map(String.init)?
            .replacingOccurrences(of: "b/", with: "") ?? "Git patch"
        return (filename, diff)
    }

    private var parsedTable: (headers: [String], rows: [[String]])? {
        guard message.role != .user, let source = message.text else { return nil }
        let lines = source.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard lines.count >= 3, lines.allSatisfy({ $0.hasPrefix("|") && $0.hasSuffix("|") }) else {
            return nil
        }
        let headers = Self.tableCells(lines[0])
        let separators = Self.tableCells(lines[1])
        guard !headers.isEmpty, separators.count == headers.count,
              separators.allSatisfy(Self.isTableSeparator) else { return nil }
        let rows = lines.dropFirst(2).map(Self.tableCells)
        guard rows.allSatisfy({ $0.count == headers.count }) else { return nil }
        return (headers, rows)
    }

    private static func tableCells(_ line: String) -> [String] {
        var body = line
        if body.first == "|" { body.removeFirst() }
        if body.last == "|" { body.removeLast() }

        var cells: [String] = []
        var cell = ""
        var escaped = false
        for character in body {
            if escaped {
                if character == "|" {
                    cell.append(character)
                } else {
                    cell.append("\\")
                    cell.append(character)
                }
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func isTableSeparator(_ cell: String) -> Bool {
        let compact = cell.replacingOccurrences(of: " ", with: "")
        let core = compact.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
        return core.count >= 3 && core.allSatisfy { $0 == "-" }
    }

    var body: some View {
        let mine = message.role == .user
        let customCard = parsedDiff != nil || parsedTable != nil
        // rooms attribute each line to the member who said it
        let speaker = message.from
        // No face beside the bubble: the bot's face is in the header, and in
        // a room the name line says who spoke. The bubble sits at the edge.
        HStack(alignment: .bottom, spacing: 0) {
            if mine { Spacer(minLength: 64) }

            VStack(alignment: .leading, spacing: 4) {
                if let speaker, !mine {
                    Text(speaker.name)
                        .font(typography.font(size: 13, relativeTo: .subheadline, weight: .semibold))
                        .foregroundStyle(MausPalette.color(speaker.color))
                }
                // Bots get markdown, you do not — the same split the desktop
                // makes. Markdown you did not intend is worse than markdown
                // you did: a message about `**` should show the asterisks.
                if let diff = parsedDiff {
                    GitPRDiffCardView(filename: diff.filename, diffText: diff.diff)
                } else if let table = parsedTable {
                    SQLResultTableView(columns: table.headers, rows: table.rows)
                } else if mine {
                    if let parsedAttachments {
                        TranscriptAttachmentGallery(paths: parsedAttachments.paths)
                        if !parsedAttachments.display.isEmpty {
                            Text(parsedAttachments.display)
                                .font(typography.body)
                                .foregroundStyle(BubbleColor.mineText)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else {
                        Text(message.text ?? "")
                            .font(typography.body)
                            .foregroundStyle(BubbleColor.mineText)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    MarkdownText(source: message.text ?? "")
                        .foregroundStyle(Color.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, customCard ? 0 : (mine ? 16 : 4))
            .padding(.vertical, customCard ? 0 : (mine ? 12 : 2))
            .background {
                if mine && !customCard {
                    SpeechBubble(tail: tailed ? .trailing : .none, cornerRadius: 20)
                        .fill(BubbleColor.mine)
                }
            }
            .padding(.bottom, mine && tailed && !customCard ? SpeechBubble.tailDrop(cornerRadius: 20) : 0)

            if !mine { Spacer(minLength: 12) }
        }
    }
}

/// User messages keep their absolute engine paths in the transcript, but the
/// phone never loads those paths as URLs. Each one is resolved by Session
/// through the authenticated, same-origin attachment route.
private struct TranscriptAttachmentGallery: View {
    let paths: [String]
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var images: [String: UIImage] = [:]
    @State private var failed: Set<String> = []

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(paths, id: \.self) { path in
                    Group {
                        if let image = images[path] {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                        } else if failed.contains(path) {
                            Image(systemName: "photo.badge.exclamationmark")
                                .font(.system(size: 22, weight: .medium))
                                .foregroundStyle(Color.secondary)
                        } else {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                    .frame(width: 156, height: 116)
                    .background(Color.black.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(Color.primary.opacity(0.14), lineWidth: 1)
                    }
                    .accessibilityLabel(failed.contains(path) ? "Attachment unavailable" : "Attached image")
                }
            }
            .padding(.vertical, 2)
        }
        .scrollDisabled(paths.count < 2)
        .task(id: paths) {
            for path in paths {
                guard images[path] == nil, !failed.contains(path), !Task.isCancelled else { continue }
                guard let data = await session.attachmentData(path: path), let image = UIImage(data: data) else {
                    failed.insert(path)
                    continue
                }
                images[path] = image
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: images.keys.sorted())
    }
}

/// Neighbouring tool chips as one disclosure. Collapsed successes are a
/// quiet "Worked · N steps"; a single success is just its spoken label;
/// live work is one updating row; failures start open. Raw names sit one
/// tap deeper and are selectable.
private struct ToolRunDisclosure: View {
    let run: ToolRun
    let isExpanded: Bool
    let onToggle: () -> Void

    @State private var revealedRawNames: Set<String> = []
    @Environment(\.conversationTypography) private var typography
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                Haptics.selection()
                onToggle()
            } label: {
                HStack(spacing: 8) {
                    headerStatus
                    Text(run.headerTitle)
                        .font(typography.detail.weight(.medium))
                        .foregroundStyle(Color.secondary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.secondary.opacity(0.65))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(run.headerTitle)
            .accessibilityHint(isExpanded ? "Hides the tool steps" : "Shows the tool steps")

            if isExpanded {
                expandedBody
                    .padding(.leading, 22)
                    .transition(reduceMotion ? .identity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.leading, 2)
        .padding(.vertical, 1)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var headerStatus: some View {
        if !run.isSettled {
            ProgressView()
                .controlSize(.mini)
                .frame(width: 12, height: 12)
        } else if run.hasFailure {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.red)
                .frame(width: 12, height: 12)
        } else {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.secondary)
                .frame(width: 12, height: 12)
        }
    }

    @ViewBuilder
    private var expandedBody: some View {
        if run.messages.count == 1, let tool = run.messages.first?.tool {
            // One chip: the header already said the friendly label, so
            // expanding is the raw name and nothing else.
            rawName(tool.name)
        } else {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(run.messages, id: \.id) { message in
                    if let tool = message.tool {
                        stepRow(message: message, tool: tool)
                    }
                }
            }
        }
    }

    private func stepRow(message: Message, tool: ToolActivity) -> some View {
        let revealed = revealedRawNames.contains(message.id)
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                Haptics.selection()
                if reduceMotion {
                    if revealed {
                        revealedRawNames.remove(message.id)
                    } else {
                        revealedRawNames.insert(message.id)
                    }
                } else {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        if revealed {
                            revealedRawNames.remove(message.id)
                        } else {
                            revealedRawNames.insert(message.id)
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    stepStatus(tool)
                    Text(ToolRunGrouping.displayLabel(for: tool))
                        .font(typography.detail)
                        .foregroundStyle(Color.primary.opacity(0.85))
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Color.secondary.opacity(0.55))
                        .rotationEffect(.degrees(revealed ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ToolRunGrouping.displayLabel(for: tool))
            .accessibilityHint(revealed ? "Hides the raw tool name" : "Shows the raw tool name")

            if revealed {
                rawName(tool.name)
                    .padding(.leading, 20)
            }
        }
    }

    @ViewBuilder
    private func stepStatus(_ tool: ToolActivity) -> some View {
        if tool.ok == nil {
            ProgressView()
                .controlSize(.mini)
                .frame(width: 12, height: 12)
        } else if tool.ok == false {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.red)
                .frame(width: 12, height: 12)
        } else {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.secondary)
                .frame(width: 12, height: 12)
        }
    }

    private func rawName(_ name: String) -> some View {
        Text(name)
            .font(typography.code)
            .foregroundStyle(Color.secondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Raw tool name")
            .accessibilityValue(name)
    }
}

/// A settled bot-to-bot message that opens the room where the exchange lives.
/// Communication is navigation, not a running tool receipt, so the row keeps
/// one quiet title and the peer's identity rather than showing a spinner.
struct CommActivityRow: View {
    let presentation: CommActivityPresentation
    let comm: CommChip
    let onOpen: (String) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.conversationTypography) private var typography

    private var peer: Bot? { session.state.bot(presentation.peerBotId) }

    var body: some View {
        rowContent
            .background(Capsule().fill(Color.secondary.opacity(0.1)))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityTitle)
            .accessibilityHint(accessibilityHint)
    }

    @ViewBuilder
    private var rowContent: some View {
        if presentation.destinationAvailable {
            Button { onOpen(presentation.groupId) } label: {
                contentLabel
            }
            .buttonStyle(.plain)
        } else {
            contentLabel
        }
    }

    private var contentLabel: some View {
        HStack(spacing: 8) {
            if let peer {
                BotAvatarView(bot: peer, size: 18, state: .happy, animated: false)
            } else {
                // The server keeps the peer's display color on the activity,
                // so a deleted/unloaded bot still has an honest visual identity.
                MausAvatar(color: comm.withColor, size: 18, state: .happy, animated: false)
            }
            Text(presentation.title)
                .font(typography.detail)
                .foregroundStyle(Color.secondary)
                .multilineTextAlignment(.leading)
                .lineLimit(1)
                .truncationMode(.tail)
            if !presentation.destinationAvailable {
                Text("Conversation unavailable")
                    .font(typography.compact)
                    .foregroundStyle(Color.secondary.opacity(0.75))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            if presentation.destinationAvailable {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.secondary.opacity(0.6))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(Capsule())
    }

    private var accessibilityTitle: String {
        presentation.destinationAvailable
            ? presentation.title
            : "\(presentation.title), conversation unavailable"
    }

    private var accessibilityHint: String {
        presentation.destinationAvailable
            ? "Open the conversation with \(peer?.name ?? comm.withName)"
            : "The conversation with \(peer?.name ?? comm.withName) is no longer available"
    }
}

/// A leftover activity the grouping did not absorb — usually a bot-to-bot
/// comm chip. Deliberately quiet; these are context, not content.
struct ActivityChip: View {
    let tool: ToolActivity?
    @Environment(\.conversationTypography) private var typography

    var body: some View {
        if let tool {
            HStack(spacing: 8) {
                Image(systemName: tool.ok == nil ? "hourglass" : tool.ok == true ? "checkmark" : "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tool.ok == false ? Color.red : Color.secondary)
                    .frame(width: 14, height: 14)
                Text(ToolRunGrouping.displayLabel(for: tool))
                    .font(typography.detail.weight(.medium))
                    .foregroundStyle(Color.primary.opacity(0.86))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                Text(tool.ok == nil ? "Running" : tool.ok == true ? "Done" : "Failed")
                    .font(typography.compact)
                    .foregroundStyle(tool.ok == false ? Color.red : Color.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Capsule().fill(VBotSurface.controlSurface.opacity(0.74)))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(ToolRunGrouping.displayLabel(for: tool))
            .accessibilityValue(tool.ok == nil ? "Running" : tool.ok == true ? "Done" : "Failed")
        }
    }
}

/// An option card. When it still has a request behind it, this is the
/// screen the companion exists for — a bot stopped, and only a person can
/// let it continue.
struct CardView: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session
    @Environment(\.conversationTypography) private var typography
    @State private var answering = false

    /// The option this card offers that means "go ahead".
    ///
    /// Deliberately not the literal string "Allow". `options` is whatever the
    /// harness sent, and it only falls back to ["Allow", "Deny"] when the
    /// provider event named no choices of its own (`server/index.ts`) — a card
    /// is free to say "Yes", "Approve", "Allow once". Answering with a string
    /// the card never offered writes the grant and then hands the harness a
    /// choice it can reject, so the bot stays stopped with nothing on screen
    /// to explain it. The conventional label wins when it is present, which
    /// keeps the ordinary permission card behaving exactly as before.
    private var allowChoice: String? {
        guard let options = message.card?.options else { return nil }
        return options.first { $0.caseInsensitiveCompare("Allow") == .orderedSame }
            ?? options.first { !Self.isRefusal($0) }
    }

    /// One definition of "the refusal", shared by the button tint and the
    /// choice above so the two cannot drift apart.
    private static func isRefusal(_ option: String) -> Bool { OptionCard.isRefusal(option) }

    private var tint: Color { MausPalette.color(chat.color) }

    var body: some View {
        if let card = message.card {
            VStack(alignment: .leading, spacing: 10) {
                if card.isPending {
                    Label("\(chat.name) is waiting on you", systemImage: "hand.raised.fill")
                        .font(typography.detail.weight(.semibold))
                        .foregroundStyle(tint)
                }
                Text(card.title)
                    .font(typography.font(size: 16, relativeTo: .headline, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(typography.font(size: 15, relativeTo: .subheadline))
                        .foregroundStyle(Color.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let held = card.held {
                    Label(held, systemImage: "exclamationmark.shield")
                        .font(typography.detail)
                        .foregroundStyle(.orange)
                }

                if card.isPending {
                    HStack(spacing: 8) {
                        ForEach(card.options, id: \.self) { option in
                            Button {
                                answering = true
                                Task {
                                    await session.answer(chat: chat, card: card, choice: option)
                                    answering = false
                                }
                            } label: {
                                Text(option)
                                    .font(typography.font(size: 15, relativeTo: .subheadline, weight: .semibold))
                                    .foregroundStyle(Self.isRefusal(option) ? Color.primary : .white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 40)
                                    .background(
                                        Capsule().fill(Self.isRefusal(option) ? Color.secondary.opacity(0.18) : tint)
                                    )
                            }
                            .buttonStyle(.plain)
                            .disabled(answering)
                        }
                    }
                    .padding(.top, 2)

                    // The grant key comes from the card. The phone never
                    // derives its own, so it cannot permit something subtly
                    // wider than the computer would have. The same goes for
                    // the answer: it is one of the options the card offered,
                    // never a string invented here.
                    if card.allowKey != nil, let allow = allowChoice, case let .bot(bot) = chat {
                        Button("Always allow this tool") {
                            answering = true
                            Task {
                                await session.alwaysAllow(bot: bot, card: card)
                                await session.answer(
                                    chat: chat,
                                    card: card,
                                    choice: allow,
                                    rememberingPermission: false
                                )
                                answering = false
                            }
                        }
                        .font(typography.compact)
                        .foregroundStyle(Color.secondary)
                        .frame(maxWidth: .infinity)
                        .disabled(answering)
                    }
                } else if let answered = card.answered {
                    Label(answered, systemImage: "checkmark.circle")
                        .font(typography.font(size: 14, relativeTo: .footnote))
                        .foregroundStyle(Color.secondary)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(card.isPending ? tint.opacity(0.12) : VBotSurface.assistantBubble)
            )
        }
    }
}

/// An OAuth-only connected-app request embedded in the transcript. The
/// browser handoff is deliberately the only credential-adjacent operation on
/// the phone: no API keys, aliases, or secret/config fields are modeled here.
private struct ConnectorCardView: View {
    let chat: Chat
    let message: Message
    let connector: ConnectorMessageData

    @EnvironmentObject private var session: Session
    @Environment(\.conversationTypography) private var typography
    @State private var actionInFlight = false
    @State private var localError: String?

    private var accent: Color { MausPalette.color(chat.color) }

    private var canAct: Bool {
        switch chat {
        case .bot: return true
        case .room: return message.from?.botId != nil
        }
    }

    private var statusTitle: String {
        switch connector.status {
        case .required: return "Needs connection"
        case .authorizing: return "Waiting for authorization"
        case .connected where connector.resumed == true: return "Ready"
        case .connected: return "Connected"
        case .failed: return "Connection failed"
        case .unknown: return "Connection unavailable"
        }
    }

    private var actionTitle: String {
        connector.status == .authorizing ? "Open authorization" : "Connect \(connector.label)"
    }

    var body: some View {
        if connector.dismissed == true {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 13) {
                HStack(alignment: .top, spacing: 12) {
                    ConnectorLogoView(connector: connector, tint: accent)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(connector.label)
                            .font(typography.font(size: 17, relativeTo: .headline, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(statusTitle)
                            .font(typography.detail.weight(.medium))
                            .foregroundStyle(statusColor)
                    }

                    Spacer(minLength: 6)

                    Button {
                        Task { await dismissCard() }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Color.secondary)
                            .frame(width: 28, height: 28)
                            .background(Circle().fill(Color.primary.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                    .disabled(actionInFlight || !canAct)
                    .accessibilityLabel("Dismiss \(connector.label) connection request")
                }

                if !connector.displayDescription.isEmpty {
                    Text(connector.displayDescription)
                        .font(typography.font(size: 15, relativeTo: .subheadline))
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }

                if let error = connector.displayError ?? localError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(typography.detail)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    if connector.status == .connected, connector.resumed != true {
                        ConnectorActionButton(
                            title: "Continue",
                            systemImage: "arrow.forward",
                            tint: accent,
                            disabled: actionInFlight || !canAct
                        ) {
                            Task { await resumeCard() }
                        }
                    } else if connector.status != .connected {
                        ConnectorActionButton(
                            title: actionTitle,
                            systemImage: "link",
                            tint: accent,
                            disabled: actionInFlight || !canAct
                        ) {
                            Task { await authorizeCard() }
                        }
                    } else {
                        Label("Connected", systemImage: "checkmark.circle.fill")
                            .font(typography.detail.weight(.semibold))
                            .foregroundStyle(.green)
                            .accessibilityLabel("\(connector.label) connected")
                    }
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(connector.status == .failed ? Color.orange.opacity(0.10) : VBotSurface.assistantBubble)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(connector.label) connection request")
            .task(id: "\(message.id)|\(connector.status.rawValue)") {
                await pollAuthorizationIfNeeded()
            }
        }
    }

    private var statusColor: Color {
        switch connector.status {
        case .connected: return .green
        case .failed: return .orange
        case .authorizing: return accent
        case .required, .unknown: return .secondary
        }
    }

    @MainActor
    private func authorizeCard() async {
        guard !actionInFlight else { return }
        actionInFlight = true
        localError = nil
        defer { actionInFlight = false }
        guard let url = await session.authorizeConnectorCard(chat: chat, message: message) else { return }
        let opened = await UIApplication.shared.open(url)
        if !opened { localError = "Authorization could not be opened on this device." }
    }

    @MainActor
    private func resumeCard() async {
        guard !actionInFlight else { return }
        actionInFlight = true
        localError = nil
        defer { actionInFlight = false }
        _ = await session.resumeConnectorCard(chat: chat, message: message)
    }

    @MainActor
    private func dismissCard() async {
        guard !actionInFlight else { return }
        actionInFlight = true
        localError = nil
        defer { actionInFlight = false }
        _ = await session.dismissConnectorCard(chat: chat, message: message)
    }

    private func pollAuthorizationIfNeeded() async {
        guard connector.status == .authorizing else { return }
        for _ in 0..<45 {
            do {
                try await Task.sleep(nanoseconds: 4_000_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            guard let response = await session.connectorCardStatus(chat: chat, message: message) else { continue }
            if response.connected || response.status?.range(of: "failed|expired|revoked|error", options: [.caseInsensitive, .regularExpression]) != nil {
                return
            }
        }
    }
}

private struct ConnectorActionButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    let disabled: Bool
    let action: () -> Void
    @Environment(\.conversationTypography) private var typography

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(typography.detail.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .frame(minHeight: 38)
                .background(Capsule().fill(tint))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.48 : 1)
    }
}

private struct ConnectorLogoView: View {
    let connector: ConnectorMessageData
    let tint: Color

    var body: some View {
        Group {
            if let url = connector.safeLogoURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else {
                        monogram
                    }
                }
            } else {
                monogram
            }
        }
        .frame(width: 42, height: 42)
        .background(Circle().fill(tint.opacity(0.16)))
        .clipShape(Circle())
        .accessibilityLabel("\(connector.label) icon")
    }

    private var monogram: some View {
        Text(String(connector.label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
            .font(.system(size: 18, weight: .bold))
            .foregroundStyle(tint)
    }
}

/// A frame of the bot's computer. In the paged shape the pixels are not in
/// the transcript — they are fetched here, once, when the row appears.
struct ScreenShot: View {
    let threadId: String
    let message: Message
    @EnvironmentObject private var session: Session
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            }
        }
        .task {
            guard image == nil else { return }
            let data: Data?
            if let inline = message.png, let decoded = Data(base64Encoded: inline) {
                data = decoded
            } else if message.hasImage == true {
                data = await session.image(threadId: threadId, messageId: message.id)
            } else {
                data = nil
            }
            image = data.flatMap(UIImage.init(data:))
        }
    }
}

/// The reply as it is being typed, styled to match the settled bubble it is
/// about to become — the handover should be invisible, and any difference in
/// padding or corner radius reads as the message jumping on arrival.
///
/// A caret rather than a spinner: a spinner says "something is happening
/// somewhere", which the reader already knows. A caret at the end of real
/// text says how far along it is.
///
/// The caret does not blink, deliberately. The obvious way to blink it —
/// `withAnimation(.repeatForever) { flag.toggle() }` in `onAppear` — animates
/// the change once and then sits still, and a caret that blinks twice and
/// stops looks more broken than one that never blinks. A correct version
/// animates opacity on a separate view, which needs a device to get right;
/// static is honest until then.
struct StreamingBubble: View {
    let text: String?
    let reasoning: String?
    var color: String = "blue"
    var speaker: (name: String, color: String)?

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                if let speaker {
                    Text(speaker.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MausPalette.color(speaker.color))
                }
                if let reasoning, !reasoning.isEmpty, text?.isEmpty != false {
                    AgentThoughtChamberView(
                        reasoning: String(reasoning.suffix(2_000)),
                        botName: speaker?.name ?? "Bot",
                        mascotColor: MausPalette.color(color),
                        isStreaming: true
                    )
                }
                if let text, !text.isEmpty {
                    // Same renderer as the settled bubble, for the same
                    // reason as the padding: a live reply showing `**bold**`
                    // that snaps to bold on arrival is the message jumping,
                    // just in a different dimension. The parser tolerates the
                    // half-finished markdown this is always holding — an
                    // unclosed fence renders as code, an unclosed link as the
                    // characters typed so far.
                    MarkdownText(source: text, caret: true)
                        .foregroundStyle(Color.primary)
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            Spacer(minLength: 12)
        }
        // No `.textSelection` on purpose: selecting text that is still growing
        // fights the reader, and the settled bubble a frame later is
        // selectable anyway.
    }
}
