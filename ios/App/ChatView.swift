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
import AVKit
import PhotosUI
import UniformTypeIdentifiers

struct ChatView: View {
    let chat: Chat
    @EnvironmentObject private var session: Session
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("conversationTextSize") private var conversationTextSize = ConversationTextSize.standard.rawValue
    @AppStorage("busySendDefault") private var busySendDefault = BusySendDefault.steer.rawValue
    @State private var draft = ""
    @State private var replyingTo: Message?
    @State private var composerRequestGate = ComposerRequestGate()
    @State private var showingTasks = false
    @State private var showingComputer = false
    @State private var showingModelPicker = false
    @State private var showingProfile = false
    @State private var showCommandHUD = false
    @State private var shareFile: ShareFile?
    @State private var commRoom: Room?
    @State private var groupProfileRoom: Room?
    @AppStorage("companion.showBotChannels") private var showBotChannels = false
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
    /// Captured when this chat opened with unread lines, so the Grok-style
    /// NEW divider survives `markRead`.
    @State private var newAfterMessageId: String?
    /// Follow the latest line only while the reader is already near the
    /// bottom. Scrolling up to copy a citation must not yank the transcript.
    @State private var followingLatest = true
    @State private var lastDistanceFromBottom: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    @State private var streamA11yPhase: StreamAccessibilityPhase = .idle
    /// Rebuild the composer after returning from a pushed computer screen.
    /// SwiftUI can retain the destination's keyboard-safe-area transaction,
    /// leaving a focused field behind the keyboard on the next appearance.
    @State private var composerLayoutRevision = 0
    @State private var activityExpanded = false
    @State private var focusedActivityChat: Chat?

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
        return max(0, session.state.unreadCount(showBotChannels: showBotChannels) - mine)
    }

    private var hidesComposer: Bool {
        if case let .room(room) = current {
            return BotChannelPolicy.hidesComposer(for: room)
        }
        return false
    }

    var body: some View {
        // Split across typed subviews so Release type-checking can finish.
        // Live tokens stay hidden; working/tool/activity remain, and the
        // settled message appears once. Near-bottom follow and VoiceOver
        // phase announcements are unchanged.
        chatPresented
    }

    /// Sheets and importers sit on their own `some View` so they are not
    /// type-checked together with the transcript ScrollView.
    private var chatPresented: some View {
        chatLifecycle
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
                allowedContentTypes: Self.importerContentTypes,
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
                Task { await importPhotos(items) }
            }
    }

    private var chatLifecycle: some View {
        chatNavigation
            .task(id: threadId) {
                // Capture the unread bit before setting the foreground thread.
                // `setForegroundThread` reconciles the local projection and
                // intentionally hides the dot while this conversation is
                // visible; checking `current.unread` after that call would
                // therefore skip the server mark-read request entirely.
                let openedChat = current
                let wasUnread = openedChat.unread
                session.setForegroundThread(threadId)
                if newAfterMessageId == nil, wasUnread {
                    newAfterMessageId = messages.last(where: { $0.role == .user })?.id
                }
                // Mark-read is idempotent. Always issue it when opening so a
                // prior optimistic attempt that failed offline is retried;
                // gating on the locally projected unread bit would otherwise
                // make that failure permanent after the receipt is hydrated.
                await session.markRead(openedChat)
#if DEBUG
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
                session.reconcileQueueReceipts(
                    forThread: threadId,
                    transcript: messages,
                    authoritativeRefresh: true
                )
            }
            .onDisappear {
                dictation.stop()
                if NotificationCoordinator.shared.foregroundThreadId == threadId {
                    session.setForegroundThread(nil)
                }
            }
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
    }

    private var chatNavigation: some View {
        chatCanvas
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
            .sheet(isPresented: $showingModelPicker) {
                if case let .bot(bot) = current {
                    ChatModelPickerSheet(bot: bot)
                        .environmentObject(session)
                        .presentationDetents([.medium, .large])
                }
            }
            .navigationDestination(item: $commRoom) { room in
                ChatView(chat: .room(room))
            }
            .navigationDestination(item: $groupProfileRoom) { room in
                GroupProfileView(room: room)
            }
            .navigationDestination(item: $focusedActivityChat) { chat in
                ChatView(chat: chat)
            }
    }

    /// Keep the composer as a sibling of the flexible transcript. A sibling
    /// participates in the navigation container's keyboard-safe layout,
    /// including the return from ComputerView, instead of relying on a
    /// nested safe-area inset that can retain a stale keyboard transaction.
    private var chatCanvas: some View {
        VStack(spacing: 0) {
            ChatTranscriptView(
                chat: current,
                followingLatest: $followingLatest,
                lastDistanceFromBottom: $lastDistanceFromBottom,
                viewportHeight: $viewportHeight,
                openedToolRuns: $openedToolRuns,
                closedToolRuns: $closedToolRuns,
                newAfterMessageId: $newAfterMessageId,
                commRoom: $commRoom,
                replyingTo: $replyingTo,
                composerFocused: $composerFocused,
                streamA11yPhase: $streamA11yPhase,
                draftIsEmpty: draft.isEmpty,
                onTranscriptChanged: { transcript in
                    session.reconcileQueueReceipts(forThread: threadId, transcript: transcript)
                },
                onOpenTemporaryTranscript: { chat in
                    session.beginOpeningFromHome(chat)
                    if ChatActivityNavigationPolicy.action(fromParentThreadId: threadId) == .pushFocusedTranscript {
                        focusedActivityChat = chat
                    }
                }
            )
            if HomeActivityRailLayoutPolicy.composerPillPlacement(
                presentationState: session.state.homeActivityPresentation(
                    queuedReceipts: [],
                    subagents: HomeInChatActivityProjectionPolicy.scopedSubagents(
                        session.state.hermesSubagents,
                        parentThreadId: threadId
                    ),
                    parentThreadId: threadId
                ).state
            ) == .immediatelyAboveComposer {
                HomeActivityPill(
                    open: { chat in
                        session.beginOpeningFromHome(chat)
                        if ChatActivityNavigationPolicy.action(fromParentThreadId: threadId) == .pushFocusedTranscript {
                            focusedActivityChat = chat
                        }
                    },
                    expanded: $activityExpanded,
                    parentThreadId: threadId
                )
                .environmentObject(session)
            }
            if !hidesComposer {
            ChatComposerView(
                chat: current,
                plusActions: plusActions,
                draft: $draft,
                replyingTo: $replyingTo,
                selectedAttachments: $selectedAttachments,
                photoItems: $photoItems,
                showingFileImporter: $showingFileImporter,
                showingCamera: $showingCamera,
                showingComputer: $showingComputer,
                showingTasks: $showingTasks,
                showCommandHUD: $showCommandHUD,
                composerFocused: $composerFocused,
                composerRequestGate: $composerRequestGate,
                attachmentError: $attachmentError,
                isUploadingAttachments: isUploadingAttachments,
                pendingQueueCount: session.queueReceipts.filter { $0.threadId == threadId }.count,
                dictation: dictation,
                onSubmit: { text, mode in
                    if let text {
                        submit(text, mode: mode)
                    } else {
                        submit(mode: mode)
                    }
                },
                onActivatePrimary: activatePrimaryAction,
                onRemoveAttachment: removeAttachment
            )
            .id(composerLayoutRevision)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .top) {
            ChatChromeView(
                chat: current,
                unreadElsewhere: unreadElsewhere,
                plusActions: plusActions,
                showingProfile: $showingProfile,
                showingModelPicker: $showingModelPicker,
                showingComputer: $showingComputer,
                groupProfileRoom: $groupProfileRoom
            )
        }
        .onAppear {
            recoverComposerAfterNavigation()
            absorbShareStaging()
        }
        .onChange(of: showingComputer) { _, shown in
            composerFocused = false
            if !shown { recoverComposerAfterNavigation() }
        }
        .onChange(of: session.stagedComposerText, initial: true) { _, _ in
            absorbShareStaging()
        }
        .onChange(of: session.stagedShareImageData, initial: true) { _, _ in
            absorbShareStaging()
        }
    }

    private func absorbShareStaging() {
        let taken = session.takeShareStaging()
        if let text = taken.text {
            draft = ShareStagingPolicy.merging(text, into: draft)
        }
        if let data = taken.imageData {
            appendSharedImage(data)
        }
    }


    private var plusActions: [ChatPlusAction] {
        var out: [ChatPlusAction] = []
        if case let .bot(bot) = current {
            out.append(ChatPlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New task",
                subtitle: "Start a fresh thread with \(bot.name)", disabled: bot.busy == true
            ) { Task { await session.createTask(for: bot, title: nil) } })
            out.append(ChatPlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            out.append(ChatPlusAction(
                id: "computer", systemImage: "display", title: "Watch computer",
                subtitle: "Live view of what \(bot.name) is doing"
            ) { showingComputer = true })
        }
        let pinned = current.pinned
        out.append(ChatPlusAction(
            id: "pin",
            systemImage: pinned ? "pin.slash" : "pin",
            title: pinned ? "Unpin" : "Pin",
            subtitle: pinned ? "Remove from the home strip" : "Keep this chat on the home strip",
            disabled: session.pendingPinnedChats.contains(current.stableID)
        ) {
            session.togglePinned(current)
        })
        out.append(ChatPlusAction(
            id: "share", systemImage: "doc.plaintext", title: "Share transcript",
            subtitle: "This chat as Markdown"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "markdown") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        out.append(ChatPlusAction(
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
            out.append(ChatPlusAction(
                id: "stop", systemImage: "stop.fill", title: "Interrupt",
                subtitle: "Stop the current turn", destructive: true
            ) { Task { await session.interrupt(bot: bot) } })
        }
        return out
    }


    // MARK: - Attachments

    private static let maxAttachmentCount = AttachmentComposerCopy.maxCount
    private static let importerContentTypes: [UTType] = [
        .image, .png, .jpeg, .gif, .mpeg4Movie, .quickTimeMovie,
    ] + [UTType(filenameExtension: "webp")].compactMap { $0 }

    private func appendSharedImage(_ data: Data) {
        guard let mime = ShareStagingPolicy.acceptedSharedImageMIME(for: data) else {
            attachmentError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        appendAttachment(data: data, mime: mime, name: "Shared photo")
    }

    private func appendAttachment(data: Data, mime: String, name: String) {
        guard selectedAttachments.count < Self.maxAttachmentCount else {
            attachmentError = AttachmentComposerCopy.tooMany()
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
            Haptics.impact(.light)
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard selectedAttachments.count < Self.maxAttachmentCount else {
                attachmentError = AttachmentComposerCopy.tooMany()
                break
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    throw APIError.transport("That photo could not be read.")
                }
                let suggested = item.supportedContentTypes.first?.preferredMIMEType
                guard let mime = AttachmentPath.sniffedMIME(data: data, suggested: suggested) else {
                    throw APIError.transport("Choose a PNG, JPEG, GIF, WebP, MP4, or MOV file.")
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
                attachmentError = AttachmentComposerCopy.tooMany()
                break
            }
            let accessed = url.startAccessingSecurityScopedResource()
            defer {
                if accessed { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url, options: [.mappedIfSafe])
                let suggested = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                    ?? url.lastPathComponent
                guard let mime = AttachmentPath.sniffedMIME(data: data, suggested: suggested) else {
                    throw APIError.transport("Choose a PNG, JPEG, GIF, WebP, MP4, or MOV file.")
                }
                appendAttachment(data: data, mime: mime, name: url.deletingPathExtension().lastPathComponent)
            } catch {
                attachmentError = AttachmentComposerCopy.importFailure(
                    name: url.lastPathComponent,
                    message: error.localizedDescription
                )
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

    private func uploadSelectedAttachments() async -> [AttachmentPrompt.Item]? {
        guard !selectedAttachments.isEmpty else { return [] }
        isUploadingAttachments = true
        defer { isUploadingAttachments = false }
        let ids = selectedAttachments.map(\.id)
        var items: [AttachmentPrompt.Item] = []
        for id in ids {
            guard let index = selectedAttachments.firstIndex(where: { $0.id == id }) else { continue }
            if let uploaded = selectedAttachments[index].uploaded {
                items.append(
                    AttachmentPrompt.Item(path: uploaded.path, mime: selectedAttachments[index].mime)
                )
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
                items.append(
                    AttachmentPrompt.Item(path: uploaded.path, mime: selectedAttachments[currentIndex].mime)
                )
            } catch {
                if let currentIndex = selectedAttachments.firstIndex(where: { $0.id == id }) {
                    selectedAttachments[currentIndex].error = error.localizedDescription
                }
                attachmentError = error.localizedDescription
                return nil
            }
        }
        return items
    }

    private func removeAttachment(_ id: UUID) {
        guard !isUploadingAttachments else { return }
        VideoAttachmentThumbnail.evict(id.uuidString)
        selectedAttachments.removeAll { $0.id == id }
        if selectedAttachments.isEmpty {
            attachmentError = nil
            session.discardShareStaging()
        }
    }

    private var selectedBusySendDefault: BusySendDefault {
        BusySendDefault(rawValue: busySendDefault)
    }

    private var composerCapabilities: EngineComposerCapabilities {
        let bot: Bot? = {
            if case let .bot(bot) = current { return bot }
            return nil
        }()
        return VBotMutationRouting.composerCapabilities(for: session.engineSync, bot: bot)
    }


    private func replyAuthor(for message: Message, in chat: Chat) -> String {
        if message.role == .user { return "You" }
        return message.from?.name ?? chat.name
    }

    private func replySnippet(for message: Message) -> String {
        let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let oneLine = text.replacingOccurrences(of: "\n", with: " ")
        let snippet = String(oneLine.prefix(120))
        return snippet.isEmpty ? "Message" : snippet
    }

    private func promptText(_ text: String, replyingTo message: Message?, in chat: Chat) -> String {
        guard let message else { return text }
        return "> \(replyAuthor(for: message, in: chat)): \(replySnippet(for: message))\n\n\(text)"
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

    private func submit(
        _ explicitText: String? = nil,
        mode explicitMode: MessageDeliveryMode? = nil
    ) {
        // This also cancels an in-flight permission prompt before it can
        // open the microphone after the message has already been sent.
        dictation.stop()
        let draftAtSubmission = draft
        let replyAtSubmission = replyingTo
        let text = (explicitText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!text.isEmpty || !selectedAttachments.isEmpty), composerRequestGate.begin() else { return }
        // Acknowledge the tap immediately. The network receipt can arrive
        // later (or wait for an attachment upload), so feedback belongs at
        // the accepted-request boundary rather than after the await.
        Haptics.keyboardTap()
        let target = current
        let mode = explicitMode ?? (target.busy ? selectedBusySendDefault.deliveryMode : .auto)
        showCommandHUD = false
        Task { @MainActor in
            let textWithReply = promptText(text, replyingTo: replyAtSubmission, in: target)
            let prompt: String
            if selectedAttachments.isEmpty {
                prompt = textWithReply
            } else if let items = await uploadSelectedAttachments() {
                prompt = AttachmentPrompt.compose(text: textWithReply, attachments: items)
            } else {
                composerRequestGate.end()
                return
            }
            let receipt = await session.send(prompt, to: target, mode: mode)
            if let receipt, receipt.ok {
                session.recordQueueReceipt(receipt, forThread: target.threadId)
                // The editor remains usable while the request is in flight.
                // Do not erase a newer draft that was typed after submission.
                if draft == draftAtSubmission { draft = "" }
                replyingTo = nil
                selectedAttachments.removeAll()
                attachmentError = nil
                SoundEffects.playSent()
            }
            composerRequestGate.end()
        }
    }

    private func recoverComposerAfterNavigation() {
        composerFocused = false
        composerLayoutRevision &+= 1
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

    private var selectedConversationTextSize: ConversationTextSize {
        ConversationTextSize(rawValue: conversationTextSize) ?? .standard
    }
}

struct MessageRow: View {
    let chat: Chat
    let message: Message
    /// Last bubble of a run from the same side: the one that gets the tail.
    var endsRun = true
    var showsSpeaker = false
    var onOpenComm: (CommChip) -> Void = { _ in }
    var onReply: (Message) -> Void = { _ in }
    @EnvironmentObject private var session: Session
    @Environment(\.conversationTypography) private var typography
    @State private var editingText = ""
    @State private var showingEdit = false

    private var showsCommAsNormalBubble: Bool {
        guard case let .room(room) = chat else { return false }
        return BotChannelPolicy.isDedicatedReadOnlyConversation(room)
            && BotChannelPolicy.dedicatedTranscriptUsesNormalBubbles
    }

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
            TextBubble(message: message, chat: chat, tailed: endsRun, showsSpeaker: showsSpeaker)
        case .options:
            CardView(chat: chat, message: message)
        case .activity:
            let destinationAvailable = message.comm.map { comm in
                session.state.rooms.contains { $0.id == comm.groupId }
            } ?? false
            if let row = CommActivityPresentation(message: message, destinationAvailable: destinationAvailable),
               let comm = message.comm,
               !showsCommAsNormalBubble {
                CommActivityRow(presentation: row, comm: comm, onOpen: onOpenComm)
            } else {
                ActivityChip(tool: message.tool)
            }
        case .connector:
            if let connector = message.connector, connector.isUsable {
                ConnectorCardView(chat: chat, message: message, connector: connector)
            } else if let text = message.text, !text.isEmpty {
                TextBubble(message: message, chat: chat, tailed: endsRun, showsSpeaker: showsSpeaker)
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
                TextBubble(message: message, chat: chat, tailed: endsRun, showsSpeaker: showsSpeaker)
            }
        }
    }

    private func reactionGroups(_ reactions: [Reaction]) -> [(emoji: String, count: Int, mine: Bool)] {
        Dictionary(grouping: reactions, by: \.emoji)
            .map { (emoji: $0.key, count: $0.value.count, mine: $0.value.contains { $0.by == "user" }) }
            .sorted { $0.emoji < $1.emoji }
    }
}

private struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

struct PendingImageAttachment: Identifiable, Equatable {
    let id: UUID
    let data: Data
    let mime: String
    let name: String
    var uploaded: UploadedAttachment?
    var error: String?

    var isVideo: Bool { mime.hasPrefix("video/") }

    init(data: Data, mime: String, name: String) {
        self.id = UUID()
        self.data = data
        self.mime = mime
        self.name = name
    }
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

private struct BubbleChromeModifier: ViewModifier {
    let customCard: Bool
    let shrinkWrapsHorizontally: Bool
    let maxBubbleWidth: CGFloat
    let textMaxWidth: CGFloat
    let mine: Bool
    let bubbleHorizontalPadding: CGFloat
    let bubbleCornerRadius: CGFloat
    let tailed: Bool

    func body(content: Content) -> some View {
        Group {
            if shrinkWrapsHorizontally && !customCard {
                content.proseBubbleSized(maxContentWidth: textMaxWidth)
            } else {
                content.frame(maxWidth: maxBubbleWidth, alignment: mine ? .trailing : .leading)
            }
        }
        .padding(.horizontal, customCard ? 0 : bubbleHorizontalPadding)
        .padding(.vertical, customCard ? 0 : 12)
        .background {
            if !customCard {
                if mine {
                    SpeechBubble(tail: tailed ? .trailing : .none, cornerRadius: bubbleCornerRadius)
                        .fill(BubbleColor.mine)
                } else {
                    RoundedRectangle(cornerRadius: bubbleCornerRadius, style: .continuous)
                        .fill(BubbleColor.theirs)
                }
            }
        }
        .padding(.bottom, mine && tailed && !customCard ? SpeechBubble.tailDrop(cornerRadius: bubbleCornerRadius) : 0)
    }
}

struct TextBubble: View {
    let message: Message
    let chat: Chat
    var tailed = true
    var showsSpeaker = false
    @Environment(\.conversationTypography) private var typography
    @Environment(\.chatPaneWidth) private var paneWidth
    @EnvironmentObject private var session: Session

    private var bubbleCornerRadius: CGFloat { ConversationLayoutPolicy.bubbleCornerRadius }
    private var maxBubbleWidth: CGFloat {
        ConversationLayoutPolicy.bubbleMaxWidth(paneWidth: paneWidth)
    }
    private var textMaxWidth: CGFloat {
        ConversationLayoutPolicy.bubbleTextMaxWidth(paneWidth: paneWidth)
    }
    private var edgeReserve: CGFloat {
        ConversationLayoutPolicy.bubbleEdgeReserve(paneWidth: paneWidth)
    }
    private var bubbleHorizontalPadding: CGFloat {
        ConversationLayoutPolicy.bubbleHorizontalPadding
    }
    private var shrinkWrapsHorizontally: Bool {
        ConversationLayoutPolicy.bubbleShrinkWrapsHorizontally(
            isCustomCard: parsedDiff != nil || parsedTable != nil || workPresentation != nil,
            hasAttachmentGallery: parsedAttachments != nil
        )
    }

    private var parsedAttachments: (display: String, imagePaths: [String], filePaths: [String])? {
        guard message.role == .user, let text = message.text else { return nil }
        let parsed = AttachmentPrompt.splitAll(text)
        return parsed.imagePaths.isEmpty && parsed.filePaths.isEmpty ? nil : parsed
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

    /// Work metadata is an optional decoration on a text message. Cursor is
    /// advertised only after URL validation and the runtime `canOpenURL` gate.
    private var workPresentation: WorkCardPresentation? {
        guard message.role != .user, let work = message.work else { return nil }
        let cursorURL = WorkCardPresentation.validatedCursorURL(work.cursorURL)
        let cursorAvailable: Bool
#if DEBUG
        // The preview harness cannot install third-party apps in a clean
        // simulator. This opt-in flag stands in for iOS's canOpenURL result
        // only for a StorePreview screenshot; production always asks iOS.
        if ProcessInfo.processInfo.arguments.contains("-store-preview"),
           ProcessInfo.processInfo.arguments.contains("-preview-cursor-available") {
            cursorAvailable = cursorURL != nil
        } else {
            cursorAvailable = cursorURL.map { UIApplication.shared.canOpenURL($0) } ?? false
        }
#else
        cursorAvailable = cursorURL.map { UIApplication.shared.canOpenURL($0) } ?? false
#endif
        let presentation = WorkCardPresentation(work: work, canOpenCursor: cursorAvailable)
        return presentation.isRenderable ? presentation : nil
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
        let customCard = parsedDiff != nil || parsedTable != nil || workPresentation != nil
        let speaker = message.from
        HStack(alignment: .bottom, spacing: 0) {
            if mine { Spacer(minLength: edgeReserve) }

            bubbleContent(mine: mine, customCard: customCard, speaker: speaker)
                .modifier(BubbleChromeModifier(
                    customCard: customCard,
                    shrinkWrapsHorizontally: shrinkWrapsHorizontally,
                    maxBubbleWidth: maxBubbleWidth,
                    textMaxWidth: textMaxWidth,
                    mine: mine,
                    bubbleHorizontalPadding: bubbleHorizontalPadding,
                    bubbleCornerRadius: bubbleCornerRadius,
                    tailed: tailed
                ))

            if !mine { Spacer(minLength: edgeReserve) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    @ViewBuilder
    private func bubbleContent(mine: Bool, customCard: Bool, speaker: Sender?) -> some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 8) {
            if !mine, showsSpeaker {
                HStack(spacing: 8) {
                    speakerAvatar
                    Text(speaker?.name ?? chat.name)
                        .font(typography.font(size: 13, relativeTo: .subheadline, weight: .semibold))
                        .foregroundStyle(Color.primary)
                }
            }
            if let diff = parsedDiff {
                GitPRDiffCardView(filename: diff.filename, diffText: diff.diff, work: workPresentation)
            } else if let work = workPresentation {
                GitPRDiffCardView(
                    filename: work.title ?? "Work",
                    diffText: "",
                    additions: work.additions ?? 0,
                    deletions: work.deletions ?? 0,
                    work: work
                )
                if let text = message.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownText(source: text)
                        .foregroundStyle(Color.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if let table = parsedTable {
                SQLResultTableView(columns: table.headers, rows: table.rows)
            } else if mine {
                if let parsedAttachments {
                    TranscriptAttachmentGallery(
                        imagePaths: parsedAttachments.imagePaths,
                        filePaths: parsedAttachments.filePaths
                    )
                    if !parsedAttachments.display.isEmpty {
                        Text(parsedAttachments.display)
                            .font(typography.body)
                            .foregroundStyle(BubbleColor.mineText)
                            .textSelection(.enabled)
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text(message.text ?? "")
                        .font(typography.body)
                        .foregroundStyle(BubbleColor.mineText)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                MarkdownText(source: message.text ?? "")
                    .foregroundStyle(Color.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var speakerAvatar: some View {
        if let speaker = message.from, let bot = session.state.bot(speaker.botId) {
            BotAvatarView(bot: bot, size: 22, state: .idle, animated: false)
        } else {
            ChatAvatarView(chat: chat, size: 22, state: .idle, animated: false)
        }
    }
}

/// User messages keep their absolute engine paths in the transcript, but the
/// phone never loads those paths as URLs. Each one is resolved by Session
/// through the authenticated, same-origin attachment route.
private struct TranscriptAttachmentGallery: View {
    let imagePaths: [String]
    let filePaths: [String]
    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var images: [String: UIImage] = [:]
    @State private var failed: Set<String> = []
    @State private var previewItem: PreviewAttachmentItem?

    private struct PreviewAttachmentItem: Identifiable {
        let id = UUID()
        let url: URL
    }

    private var paths: [String] { imagePaths + filePaths }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(paths, id: \.self) { path in
                    let isVideo = Self.isVideoPath(path)
                    Button {
                        guard isVideo, !failed.contains(path), images[path] != nil else { return }
                        Task {
                            guard let data = await session.attachmentData(path: path) else {
                                failed.insert(path)
                                return
                            }
                            let ext = URL(fileURLWithPath: path).pathExtension.isEmpty
                                ? "mp4"
                                : URL(fileURLWithPath: path).pathExtension
                            do {
                                let url = try await Task.detached(priority: .utility) {
                                    try VideoPreviewFile.writeOnce(data, extension: ext)
                                }.value
                                previewItem = PreviewAttachmentItem(url: url)
                            } catch {
                                failed.insert(path)
                            }
                        }
                    } label: {
                        ZStack {
                            Group {
                                if let image = images[path] {
                                    Image(uiImage: image)
                                        .resizable()
                                        .scaledToFill()
                                } else if failed.contains(path) {
                                    Image(systemName: isVideo ? "video.slash" : "photo.badge.exclamationmark")
                                        .font(.system(size: 22, weight: .medium))
                                        .foregroundStyle(Color.secondary)
                                } else {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                            }
                            if isVideo, images[path] != nil {
                                Image(systemName: "play.circle.fill")
                                    .font(.system(size: 34, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.92))
                                    .shadow(radius: 4)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!isVideo || failed.contains(path) || images[path] == nil)
                    .frame(width: 156, height: 116)
                    .background(Color.black.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(Color.primary.opacity(0.14), lineWidth: 1)
                    }
                    .accessibilityLabel(
                        failed.contains(path)
                            ? "Attachment unavailable"
                            : isVideo ? "Attached video" : "Attached image"
                    )
                }
            }
            .padding(.vertical, 2)
        }
        .scrollDisabled(paths.count < 2)
        .task(id: paths) {
            for path in paths {
                guard images[path] == nil, !failed.contains(path), !Task.isCancelled else { continue }
                if Self.isVideoPath(path) {
                    guard let data = await session.attachmentData(path: path) else {
                        failed.insert(path)
                        continue
                    }
                    let mime = URL(fileURLWithPath: path).pathExtension.lowercased() == "mov"
                        ? "video/quicktime"
                        : "video/mp4"
                    if let thumbnail = await VideoAttachmentThumbnail.make(from: data, mime: mime, cacheKey: path) {
                        images[path] = thumbnail
                    } else {
                        failed.insert(path)
                    }
                } else if let data = await session.attachmentData(path: path), let image = UIImage(data: data) {
                    images[path] = image
                } else {
                    failed.insert(path)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: images.keys.sorted())
        .sheet(item: $previewItem, onDismiss: releasePreviewFile) { item in
            AttachmentVideoPlayer(url: item.url, onTeardown: releasePreviewFile)
                .ignoresSafeArea()
        }
    }

    private func releasePreviewFile() {
        if let url = previewItem?.url {
            VideoPreviewFile.remove(url)
        }
        previewItem = nil
    }

    private static func isVideoPath(_ path: String) -> Bool {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        return ext == "mp4" || ext == "mov"
    }
}

private enum VideoPreviewFile {
    static func writeOnce(_ data: Data, extension ext: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vbot-preview-\(UUID().uuidString).\(ext)")
        try data.write(to: url, options: .atomic)
        return url
    }

    static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}

private struct AttachmentVideoPlayer: UIViewControllerRepresentable {
    let url: URL
    var onTeardown: () -> Void = {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onTeardown: onTeardown)
    }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = AVPlayer(url: url)
        controller.player?.play()
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
        controller.player?.pause()
        controller.player?.replaceCurrentItem(with: nil)
        controller.player = nil
        coordinator.onTeardown()
    }

    final class Coordinator {
        let onTeardown: () -> Void

        init(onTeardown: @escaping () -> Void) {
            self.onTeardown = onTeardown
        }
    }
}

enum VideoAttachmentThumbnail {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 10
        cache.totalCostLimit = 10 * 128 * 128 * 4
        return cache
    }()

    static func evict(_ cacheKey: String) {
        cache.removeObject(forKey: cacheKey as NSString)
    }

    static func make(from data: Data, mime: String, cacheKey: String) async -> UIImage? {
        if let cached = cache.object(forKey: cacheKey as NSString) { return cached }
        guard !Task.isCancelled else { return nil }
        let ext = mime.contains("quicktime") ? "mov" : "mp4"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vbot-thumb-\(UUID().uuidString).\(ext)")
        do {
            try await write(data, to: url)
            guard !Task.isCancelled else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            let image = await generate(from: url)
            try? FileManager.default.removeItem(at: url)
            return store(image, cacheKey: cacheKey)
        } catch {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    static func make(from url: URL, cacheKey: String) async -> UIImage? {
        if let cached = cache.object(forKey: cacheKey as NSString) { return cached }
        guard !Task.isCancelled else { return nil }
        return store(await generate(from: url), cacheKey: cacheKey)
    }

    private static func store(_ image: UIImage?, cacheKey: String) -> UIImage? {
        guard let image, !Task.isCancelled else { return image }
        cache.setObject(image, forKey: cacheKey as NSString, cost: 128 * 128 * 4)
        return image
    }

    private static func write(_ data: Data, to url: URL) async throws {
        try await Task.detached(priority: .utility) {
            try data.write(to: url, options: .atomic)
        }.value
    }

    private static func generate(from url: URL) async -> UIImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 128, height: 128)
        final class CancelBox: @unchecked Sendable {
            let gate = ResumeOnce<UIImage?>()
            var generator: AVAssetImageGenerator?
        }
        let box = CancelBox()
        box.generator = generator
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                box.gate.attach(continuation)
                generator.generateCGImageAsynchronously(for: .zero) { cgImage, _, _ in
                    box.gate.resume(returning: cgImage.map { UIImage(cgImage: $0) })
                }
            }
        } onCancel: {
            box.generator?.cancelAllCGImageGeneration()
            box.gate.resume(returning: nil)
        }
    }
}

/// Neighbouring tool chips as one disclosure. Collapsed successes are a
/// quiet "Worked · N steps"; a single success is just its spoken label;
/// live work is one updating row; failures start open. Raw names sit one
/// tap deeper and are selectable.
struct ToolRunDisclosure: View {
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

/// A settled bot-to-bot message that opens the dedicated conversation.
/// In the parent transcript this is a compact centered caption, not a bubble.
struct CommActivityRow: View {
    let presentation: CommActivityPresentation
    let comm: CommChip
    let onOpen: (CommChip) -> Void

    @EnvironmentObject private var session: Session

    private var peer: Bot? { session.state.bot(presentation.peerBotId) }

    var body: some View {
        rowContent
            .accessibilityElement(children: .combine)
            .accessibilityLabel(presentation.accessibilityLabel)
            .accessibilityHint(presentation.accessibilityHint)
    }

    @ViewBuilder
    private var rowContent: some View {
        if presentation.destinationAvailable {
            Button { onOpen(comm) } label: {
                contentLabel
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
        } else {
            contentLabel
        }
    }

    private var contentLabel: some View {
        HStack(spacing: 6) {
            if presentation.showsPeerAvatar {
                peerAvatar
            }
            Text(presentation.captionText)
                .font(.system(size: presentation.visualFontSizePoints, weight: .regular))
                .foregroundStyle(Color.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, minHeight: presentation.minimumHitTarget)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var peerAvatar: some View {
        if let peer {
            BotAvatarView(bot: peer, size: 14, state: .happy, animated: false)
        } else {
            MausAvatar(color: comm.withColor, size: 14, state: .happy, animated: false)
        }
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
    @State private var showingApprovalDetails = false

    private var tint: Color { MausPalette.color(chat.color) }

    var body: some View {
        if let card = message.card {
            cardContent(card)
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(card.isPending && card.isPermission ? tint.opacity(0.11) : VBotSurface.assistantBubble)
            )
            .sheet(isPresented: $showingApprovalDetails) {
                ApprovalDetailSheet(chat: chat, card: card)
                    .environmentObject(session)
            }
        }
    }

    @ViewBuilder
    private func cardContent(_ card: OptionCard) -> some View {
        if card.isPermission && card.isPending {
            Button {
                Haptics.soft()
                showingApprovalDetails = true
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Label("\(chat.name) needs your approval", systemImage: "hand.raised.fill")
                        .font(typography.detail.weight(.semibold))
                        .foregroundStyle(tint)
                    Text(actionSummary(for: card))
                        .font(typography.font(size: 16, relativeTo: .body, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 5) {
                        Text("Tap to review")
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .font(typography.compact)
                    .foregroundStyle(Color.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(chat.name) needs your approval")
            .accessibilityValue(actionSummary(for: card))
            .accessibilityHint("Opens details and approval actions")
        } else if card.isPermission {
            VStack(alignment: .leading, spacing: 5) {
                Text(resolvedTitle(for: card))
                    .font(typography.font(size: 16, relativeTo: .headline, weight: .semibold))
                    .foregroundStyle(card.answered?.lowercased().contains("deny") == true ? Color.red.opacity(0.9) : Color.primary)
                Text(actionSummary(for: card))
                    .font(typography.font(size: 15, relativeTo: .subheadline))
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        } else {
            questionContent(card)
        }
    }

    private func questionContent(_ card: OptionCard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if card.isPending {
                Label("\(chat.name) is waiting on you", systemImage: "hand.raised.fill")
                    .font(typography.detail.weight(.semibold))
                    .foregroundStyle(tint)
            }
            Text(OptionCard.sanitizedPresentation(card.title))
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
                                .foregroundStyle(Color.primary)
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: 44)
                                .background(Capsule().fill(Color.secondary.opacity(0.18)))
                        }
                        .buttonStyle(.plain)
                        .disabled(answering)
                    }
                }
            } else if let answered = card.answered {
                Label(answered, systemImage: "checkmark.circle")
                    .font(typography.font(size: 14, relativeTo: .footnote))
                    .foregroundStyle(Color.secondary)
            }
        }
    }

    private func actionSummary(for card: OptionCard) -> String {
        if let summary = card.actionSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
            return OptionCard.sanitizedPresentation(summary)
        }
        if let toolLabel = card.toolLabel, let hostLabel = card.hostLabel {
            return OptionCard.sanitizedPresentation("Run \(toolLabel.lowercased()) on \(hostLabel)")
        }
        return OptionCard.sanitizedPresentation(card.title.replacingOccurrences(of: "?", with: ""))
    }

    private func resolvedTitle(for card: OptionCard) -> String {
        guard let answered = card.answered?.lowercased() else { return OptionCard.sanitizedPresentation(card.title) }
        return answered.contains("deny") ? "Bot’s request denied" : "Request approved"
    }
}

/// Full details for a pending permission request. The transcript remains
/// compact; this sheet is the only place that exposes bounded command text.
private struct ApprovalDetailSheet: View {
    let chat: Chat
    let card: OptionCard
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.conversationTypography) private var typography
    @State private var answering = false

    private var allowChoice: String { card.permissionAllowChoice ?? "Allow" }
    private var denyChoice: String { card.permissionDenyChoice ?? "Deny" }
    private var actionSummary: String {
        if let summary = card.actionSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty { return OptionCard.sanitizedPresentation(summary) }
        if let toolLabel = card.toolLabel, let hostLabel = card.hostLabel { return OptionCard.sanitizedPresentation("Run \(toolLabel.lowercased()) on \(hostLabel)") }
        return OptionCard.sanitizedPresentation(card.title.replacingOccurrences(of: "?", with: ""))
    }
    private var details: String? {
        let value = OptionCard.sanitizedPresentation(card.details ?? card.subtitle)
        return value.isEmpty ? nil : value
    }
    private var reason: String {
        if let value = card.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            return OptionCard.sanitizedPresentation(value)
        }
        return "This action needs your permission before the bot can continue. Nothing happens unless you approve."
    }
    private var alwaysAllowSummary: String? {
        guard let value = card.alwaysAllowSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        let sanitized = OptionCard.sanitizedPresentation(value)
        return sanitized.isEmpty ? nil : sanitized
    }
    private var executiveSummary: String? {
        guard let value = card.executiveSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return OptionCard.sanitizedPresentation(value)
    }
    private var changeSummary: String? {
        guard let value = card.changeSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return OptionCard.sanitizedPresentation(value)
    }
    private var resourceSummary: String? {
        guard let value = card.resourceSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return OptionCard.sanitizedPresentation(value)
    }
    private var riskSummary: String? {
        guard let value = card.riskLevel?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value.capitalized
    }
    private var riskColor: Color {
        switch card.riskLevel?.lowercased() {
        case "high": return .red
        case "medium": return .orange
        default: return .green
        }
    }
    private var advisorySummary: String? {
        guard let value = card.advisorySummary?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return OptionCard.sanitizedPresentation(value)
    }
    @ViewBuilder
    private func explanationBlock(_ title: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(typography.font(size: 15, relativeTo: .headline, weight: .semibold))
                .foregroundStyle(Color.secondary)
            Text(value)
                .font(typography.font(size: 16, relativeTo: .body))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(VBotSurface.assistantBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
    private var detailsLabel: String {
        card.toolLabel?.caseInsensitiveCompare("Terminal") == .orderedSame ? "Command" : "Details"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Bot needs your approval")
                        .font(typography.font(size: 24, relativeTo: .title2, weight: .bold))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Reason")
                            .font(typography.font(size: 16, relativeTo: .headline, weight: .semibold))
                        Text(reason)
                            .font(typography.font(size: 16, relativeTo: .body))
                            .foregroundStyle(Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let alwaysAllowSummary {
                            Divider()
                                .overlay(Color.white.opacity(0.08))
                            Text("Always allow")
                                .font(typography.font(size: 15, relativeTo: .subheadline, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                            Text(alwaysAllowSummary)
                                .font(typography.font(size: 14, relativeTo: .subheadline))
                                .foregroundStyle(Color.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(VBotSurface.assistantBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                    if let executiveSummary {
                        explanationBlock("What this does", executiveSummary)
                    }
                    if let changeSummary, changeSummary.caseInsensitiveCompare("Nothing; read-only") != .orderedSame {
                        explanationBlock("What changes", changeSummary)
                    }
                    if let resourceSummary {
                        explanationBlock("Where", resourceSummary)
                    }
                    if let riskSummary {
                        explanationBlock("Risk", riskSummary, color: riskColor)
                    }
                    if let advisorySummary {
                        explanationBlock("AI review · advisory", advisorySummary, color: .secondary)
                    }

                    if let held = card.held {
                        Label(held, systemImage: "exclamationmark.shield")
                            .font(typography.detail)
                            .foregroundStyle(.orange)
                    }

                    if let details {
                        DisclosureGroup {
                            Text(details)
                                .font(typography.code)
                                .foregroundStyle(Color.primary.opacity(0.86))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                                .background(VBotSurface.controlSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                .padding(.top, 4)
                        } label: {
                            Text(detailsLabel)
                                .font(typography.compact.weight(.semibold))
                                .foregroundStyle(Color.secondary)
                        }
                        .tint(Color.secondary)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Request")
                            .font(typography.compact.weight(.semibold))
                            .foregroundStyle(Color.secondary)
                        Text(actionSummary)
                            .font(typography.font(size: 16, relativeTo: .body))
                            .foregroundStyle(Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 22)
                .padding(.top, 18)
                .padding(.bottom, 140)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    HStack(spacing: 12) {
                        Button("Deny") { answer(denyChoice) }
                            .buttonStyle(ApprovalActionButtonStyle(role: .deny))
                            .accessibilityHint("Declines this request")
                        Button("Allow") { answer(allowChoice) }
                            .buttonStyle(ApprovalActionButtonStyle(role: .allow))
                            .accessibilityHint("Allows this request once")
                    }
                    if alwaysAllowSummary != nil, card.allowKey != nil, case .bot = chat {
                        Button("Always allow") {
                            answering = true
                            Task {
                                if case let .bot(bot) = chat { await session.alwaysAllow(bot: bot, card: card) }
                                await session.answer(chat: chat, card: card, choice: allowChoice, rememberingPermission: false)
                                answering = false
                                dismiss()
                            }
                        }
                        .font(typography.compact)
                        .foregroundStyle(Color.secondary)
                        .frame(minHeight: 44)
                        .disabled(answering)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 10)
                .padding(.bottom, 8)
                .background(.ultraThinMaterial)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close approval details")
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(VBotSurface.background)
        }
    }

    private func answer(_ choice: String) {
        guard !answering else { return }
        answering = true
        Haptics.soft()
        Task {
            await session.answer(chat: chat, card: card, choice: choice, rememberingPermission: false)
            answering = false
            dismiss()
        }
    }
}

private struct ApprovalActionButtonStyle: ButtonStyle {
    enum Role { case allow, deny }
    let role: Role
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(role == .allow ? Color.black : .white)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(role == .allow ? Color.white : Color.red)
                    .opacity(configuration.isPressed ? 0.78 : 1)
            )
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.98 : 1))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var actionInFlight = false
    @State private var localError: String?
    @State private var playedConnectSound = false

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
            .onChange(of: connector.status) { _, status in
                if status == .connected { playConnectSoundIfNeeded() }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await refreshAuthorizationStatus() }
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

    @MainActor
    private func refreshAuthorizationStatus() async {
        guard (connector.status == .authorizing || connector.status == .required),
              !Task.isCancelled,
              canAct
        else { return }
        guard let response = await session.connectorCardStatus(chat: chat, message: message) else { return }
        if response.connected { playConnectSoundIfNeeded() }
    }

    @MainActor
    private func playConnectSoundIfNeeded() {
        guard !playedConnectSound else { return }
        playedConnectSound = true
        SoundEffects.playConnect()
    }

    @MainActor
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
            if response.connected {
                playConnectSoundIfNeeded()
                return
            }
            if response.status?.range(of: "failed|expired|revoked|error", options: [.caseInsensitive, .regularExpression]) != nil {
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
