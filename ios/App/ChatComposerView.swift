import CompanionCore
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Composer: attachments, mentions, slash HUD, dictation, send/stop.
struct ChatComposerView: View {
    let chat: Chat
    let plusActions: [ChatPlusAction]
    @Binding var draft: String
    @Binding var replyingTo: Message?
    @Binding var selectedAttachments: [PendingImageAttachment]
    @Binding var photoItems: [PhotosPickerItem]
    @Binding var showingFileImporter: Bool
    @Binding var showingCamera: Bool
    @Binding var showingComputer: Bool
    @Binding var showingTasks: Bool
    @Binding var showCommandHUD: Bool
    @FocusState.Binding var composerFocused: Bool
    @Binding var composerRequestGate: ComposerRequestGate
    @Binding var attachmentError: String?
    let isUploadingAttachments: Bool
    let pendingQueueCount: Int
    @ObservedObject var dictation: SpeechDictation
    var onSubmit: (String?, MessageDeliveryMode?) -> Void
    var onActivatePrimary: () -> Void
    var onRemoveAttachment: (UUID) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conversationTypography) private var chatTypography
    @AppStorage("busySendDefault") private var busySendDefault = BusySendDefault.steer.rawValue

    private static let maxAttachmentCount = AttachmentComposerCopy.maxCount

    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
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

    private var activeMentionQuery: String? {
        guard case .room = current else { return nil }
        return GroupRouting.activeMentionQuery(in: draft)
    }

    private var mentionCandidates: [GroupRouting.Member] {
        guard let query = activeMentionQuery else { return [] }
        return GroupRouting.mentionCandidates(query: query, members: roomMembers)
    }

    private var highlightedMentionName: String? {
        guard let query = activeMentionQuery else { return nil }
        if case let .accept(name) = GroupRouting.mentionReturnAction(
            query: query,
            candidates: mentionCandidates
        ) {
            return name
        }
        return nil
    }

    private var composerPlaceholder: String {
        if dictation.isListening { return "Listening…" }
        if case let .room(room) = current {
            return GroupRouting.groupComposerHint(room: room, members: roomMembers)
        }
        return "Ask \(current.name)"
    }

    private var primaryAction: ComposerPrimaryAction {
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

    var body: some View {
        VStack(spacing: 6) {
            if let replyingTo {
                replyBanner(for: replyingTo)
            }
            attachmentPreviewStrip

            if pendingQueueCount > 0 {
                Label(
                    pendingQueueCount == 1
                        ? "Queued · waiting for current work"
                        : "\(pendingQueueCount) queued · waiting for current work",
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
                let message = AttachmentComposerCopy.visibleError(attachmentError)
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(chatTypography.detail)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(message)
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
                    default: onSubmit(command.command, nil)
                    }
                }
                .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
            }

            HStack(alignment: .center, spacing: ConversationLayoutPolicy.composerControlGap) {
                Menu {
                    attachmentPickerMenuItems
                    Divider()
                    ForEach(plusActions) { action in
                        Button(role: action.destructive ? .destructive : nil) {
                            action.run()
                        } label: {
                            Label(action.title, systemImage: action.systemImage)
                        }
                        .disabled(action.disabled)
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(
                            width: ConversationLayoutPolicy.composerButtonDiameter,
                            height: ConversationLayoutPolicy.composerButtonDiameter
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassCircle()
                .accessibilityLabel("More")

                HStack(alignment: .center, spacing: 2) {
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
                        .foregroundStyle(Color.primary)
                        .padding(.leading, showCommandHUD || draft.hasPrefix("/") ? 0 : 16)
                        .padding(.vertical, 12)
                        .focused($composerFocused)
                        .submitLabel(.send)
                        .allowsHitTesting(!dictation.isListening && !dictation.isStarting)
                        .onChange(of: draft) { _, value in
                            updateState(.easeInOut(duration: 0.15)) {
                                showCommandHUD = value.hasPrefix("/")
                            }
                        }
                        .onKeyPress(.return, phases: .down) { press in
                            guard !press.modifiers.contains(.shift) else { return .ignored }
                            if acceptTopMentionIfNeeded() { return .handled }
                            onActivatePrimary()
                            return .handled
                        }
                        .onSubmit {
                            if acceptTopMentionIfNeeded() { return }
                            onActivatePrimary()
                        }

                    composerTrailingControl
                }
                .frame(minHeight: ConversationLayoutPolicy.composerBarHeight)
                .glassCapsuleBackdrop()
            }
        }
        .padding(.horizontal, ConversationLayoutPolicy.composerHorizontalPadding)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(VBotSurface.background.ignoresSafeArea(.container, edges: .bottom))
    }

    private func insertMention(_ name: String) {
        draft = GroupRouting.applyingMention(name, to: draft)
        Haptics.selection()
    }

    @discardableResult
    private func acceptTopMentionIfNeeded() -> Bool {
        guard let query = activeMentionQuery else { return false }
        switch GroupRouting.mentionReturnAction(query: query, candidates: mentionCandidates) {
        case let .accept(name):
            insertMention(name)
            return true
        case .ignore:
            return false
        }
    }

    private func updateState(_ animation: Animation, _ updates: () -> Void) {
        if reduceMotion {
            updates()
        } else {
            withAnimation(animation, updates)
        }
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

    private func replyBanner(for message: Message) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(MausPalette.color(current.color))
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text("Replying to \(replyAuthor(for: message, in: current))")
                    .font(chatTypography.detail.weight(.semibold))
                    .foregroundStyle(Color.primary)
                Text(replySnippet(for: message))
                    .font(chatTypography.detail)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 4)

            Button {
                replyingTo = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Color.primary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel reply")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(VBotSurface.controlSurface)
        )
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var attachmentPickerMenuItems: some View {
        PhotosPicker(
            selection: $photoItems,
            maxSelectionCount: max(1, Self.maxAttachmentCount - selectedAttachments.count),
            matching: .any(of: [.images, .videos])
        ) {
            Label("Photo library", systemImage: "photo.on.rectangle")
        }
        .disabled(selectedAttachments.count >= Self.maxAttachmentCount)

        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button {
                showingCamera = true
            } label: {
                Label("Take photo", systemImage: "camera")
            }
            .disabled(selectedAttachments.count >= Self.maxAttachmentCount)
        }

        Button {
            showingFileImporter = true
        } label: {
            Label("Choose file", systemImage: "folder")
        }
        .disabled(selectedAttachments.count >= Self.maxAttachmentCount)
    }

    @ViewBuilder
    private var attachmentPreviewStrip: some View {
        if !selectedAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(selectedAttachments) { attachment in
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if attachment.isVideo {
                                    ComposerVideoThumbnail(attachment: attachment)
                                } else if let image = UIImage(data: attachment.data) {
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
                                onRemoveAttachment(attachment.id)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 22, height: 22)
                                    .background(Circle().fill(Color.black.opacity(0.68))
                                    )
                            }
                            .buttonStyle(.plain)
                            .disabled(isUploadingAttachments)
                            .accessibilityLabel(AttachmentComposerCopy.removeLabel(name: attachment.name))
                        }
                        .accessibilityElement(children: .contain)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 3)
            }
            .frame(height: 74)
            .accessibilityLabel("Selected attachments")
        }
    }

    @ViewBuilder
    private var composerTrailingControl: some View {
        Group {
            if dictation.isListening {
                composerMicButton
            } else {
                switch primaryAction {
                case .stop:
                    composerStopButton
                case .send(let mode):
                    composerSendButton(mode: mode)
                case .none:
                    composerMicButton
                }
            }
        }
        .id(composerTrailingControlIdentity)
        .frame(width: 44, height: 44)
        .padding(.trailing, 6)
    }

    private var composerTrailingControlIdentity: String {
        if dictation.isListening { return "mic-listening" }
        switch primaryAction {
        case .stop: return "stop"
        case .send(let mode): return "send-\(mode.rawValue)"
        case .none: return "mic-idle"
        }
    }

    private var composerMicButton: some View {
        Button {
            composerFocused = false
            dictation.toggle(capturing: draft)
        } label: {
            Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(dictation.isListening ? Color.red : Color.secondary)
                .frame(width: 44, height: 44)
                .symbolEffect(.pulse, isActive: dictation.isListening && !reduceMotion)
        }
        .buttonStyle(ComposerActionButtonStyle(reduceMotion: reduceMotion))
        .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
    }

    private var composerStopButton: some View {
        Button { onActivatePrimary() } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 34)
                .background(Circle().fill(Color.red))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(ComposerActionButtonStyle(reduceMotion: reduceMotion))
        .disabled(composerRequestGate.isInFlight)
        .accessibilityLabel(current.isBot ? "Stop current work" : "Stop active responder")
        .accessibilityHint(
            current.isBot
                ? "Interrupts the active turn for this conversation"
                : "Interrupts the active responder; queued messages remain"
        )
    }

    private func composerSendButton(mode: MessageDeliveryMode) -> some View {
        Button {
            if acceptTopMentionIfNeeded() { return }
            onSubmit(nil, mode)
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Color.black)
                .frame(width: 34, height: 34)
                .background(Circle().fill(Color.white))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(ComposerActionButtonStyle(reduceMotion: reduceMotion))
        .disabled(composerRequestGate.isInFlight)
        .contextMenu {
            if composerCapabilities.steer {
                Button {
                    onSubmit(nil, .steer)
                } label: {
                    Label("Steer now", systemImage: "arrow.turn.up.right")
                }
            }
            if composerCapabilities.queueing {
                Button {
                    onSubmit(nil, .queue)
                } label: {
                    Label("Queue after current work", systemImage: "clock.arrow.circlepath")
                }
            }
        }
        .accessibilityLabel(mode == .steer ? "Send and steer" : mode == .queue ? "Send and queue" : "Send")
        .accessibilityHint(
            highlightedMentionName.map(GroupRouting.mentionReturnHint)
                ?? "Touch and hold for explicit steer or queue choices"
        )
    }
}

private struct ComposerActionButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(
                reduceMotion ? nil : .snappy(duration: 0.16, extraBounce: 0.02),
                value: configuration.isPressed
            )
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
                mentionRow(
                    title: "@everyone",
                    subtitle: "Every bot in this chat",
                    color: accentColor,
                    highlighted: true
                ) {
                    onPick("everyone")
                }
            }
            ForEach(Array(members.enumerated()), id: \.element.id) { index, member in
                mentionRow(
                    title: member.name,
                    subtitle: "Bring \(member.name) in",
                    color: MausPalette.color(member.color),
                    highlighted: !includeEveryone && index == 0
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
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mention a bot")
    }

    private func mentionRow(
        title: String,
        subtitle: String,
        color: Color,
        highlighted: Bool,
        action: @escaping () -> Void
    ) -> some View {
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
                    Text(GroupRouting.mentionRowLabel(name: title))
                        .font(.body.weight(.medium))
                        .foregroundStyle(color)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(GroupRouting.mentionRowLabel(name: title))
        .accessibilityHint(
            highlighted ? GroupRouting.mentionReturnHint(name: title) : subtitle
        )
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }
}

private struct ComposerVideoThumbnail: View {
    let attachment: PendingImageAttachment
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "video")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.secondary)
            }
            Image(systemName: "play.circle.fill")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
        }
        .task(id: attachment.id) {
            image = await VideoAttachmentThumbnail.make(
                from: attachment.data,
                mime: attachment.mime,
                cacheKey: attachment.id.uuidString
            )
        }
    }
}
