// Settings stays status-first. Network details and destructive pairing
// controls live one level deeper so the everyday screen remains calm.
import SwiftUI
import CompanionCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @AppStorage("conversationTextSize") private var conversationTextSize = ConversationTextSize.standard.rawValue
    @AppStorage("busySendDefault") private var busySendDefault = BusySendDefault.steer.rawValue
    @AppStorage(CompanionPreferences.hapticsKey) private var hapticsEnabled = true
    @AppStorage(CompanionPreferences.soundsKey) private var soundsEnabled = true
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.reduced.rawValue
    @AppStorage(PrefKey.islandIntro) private var islandIntro = IslandIntro.oncePerBot.rawValue
    @State private var permissionDefault: PermissionMode = .ask
    @State private var permissionPolicyLoaded = false
    @State private var approvalReviewer: ApprovalReviewerStatus?
    @State private var approvalReviewerLoaded = false
    @State private var enablingNotifications = false
    private let onConnect: (() -> Void)?
    private let onOpenChat: ((Chat) -> Void)?

    init(onConnect: (() -> Void)? = nil, onOpenChat: ((Chat) -> Void)? = nil) {
        self.onConnect = onConnect
        self.onOpenChat = onOpenChat
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                computerSection
                notificationsSection
                hapticsSection
                if session.connection != nil {
                    integrationsSection
                    workspaceSection
                    appearanceSection
                    chatPreferencesSection
                    busySection
                    permissionsSection
                    approvalReviewerSection
                }
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, VBotSurface.Space.section)
            .padding(.bottom, 36)
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
        .tint(Color.accentColor)
        .task {
            await session.refreshNotificationAuthorization()
            if let policy = await session.permissionPolicy() {
                permissionDefault = policy.defaultMode
                permissionPolicyLoaded = true
            }
            if let reviewer = await session.approvalReviewer() {
                approvalReviewer = reviewer
                approvalReviewerLoaded = true
            }
        }
    }

    private var computerSection: some View {
        VBotSurfaceGroup(title: "Computers") {
            if let connection = session.connection {
                NavigationLink {
                    ConnectedComputersView()
                } label: {
                    ComputerSettingsRow(
                        name: ConnectionPresentationPolicy.displayName(for: connection),
                        status: computerStatusText,
                        connected: session.status == .live
                    )
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .frame(minHeight: VBotSurface.Hit.row)
            } else {
                Button {
                    onConnect?()
                } label: {
                    ComputerSettingsRow(
                        name: "Connect a computer",
                        status: "Not connected",
                        connected: false,
                        showsChevron: false
                    )
                }
                .buttonStyle(.plain)
                .disabled(onConnect == nil)
                .padding(.horizontal, 16)
                .frame(minHeight: VBotSurface.Hit.row)
            }
        }
    }

    private var notificationsSection: some View {
        VBotSurfaceGroup(
            footer: "Alerts arrive while V Bot is open or was recently in the background (about two minutes while a bot is working). Closed-app delivery is not available yet."
        ) {
            Group {
                if notificationsAreEnabled {
                    notificationRow
                } else {
                    Button {
                        enablingNotifications = true
                        Task {
                            await session.enableNotifications()
                            enablingNotifications = false
                        }
                    } label: {
                        notificationRow
                    }
                    .buttonStyle(.plain)
                    .disabled(enablingNotifications)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)
            .accessibilityHint(notificationAccessibilityHint)
        }
    }

    private var hapticsSection: some View {
        VBotSurfaceGroup(
            title: "Haptics & Sounds",
            footer: "Feel a light tap when you press a button, swipe a row, or save a photo. Sounds play for sends, replies, and connections."
        ) {
            Toggle(isOn: $hapticsEnabled) {
                Label {
                    Text("Haptics")
                } icon: {
                    SettingsIcon(symbol: "hand.tap", color: .purple)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)

            VBotHairline().padding(.leading, 56)

            Toggle(isOn: $soundsEnabled) {
                Label {
                    Text("Sounds")
                } icon: {
                    SettingsIcon(symbol: "speaker.wave.2", color: .blue)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var integrationsSection: some View {
        VBotSurfaceGroup(
            title: "Integrations",
            footer: "Connect Hermes and workspace apps on this computer. For another machine, pair that V Bot first."
        ) {
            workspaceLink(
                title: "Hermes",
                symbol: "sparkles",
                color: .mint,
                destination: HermesSetupView(onOpenChat: onOpenChat)
            )
            VBotHairline().padding(.leading, 56)
            workspaceLink(
                title: "Connected Apps",
                symbol: "link",
                color: .blue,
                destination: ConnectedAppsView()
            )
        }
    }

    private var workspaceSection: some View {
        VBotSurfaceGroup(title: "Workspace") {
            workspaceLink(
                title: "Hidden chats",
                symbol: "eye.slash",
                color: .gray,
                destination: HiddenChatsView()
            )
            VBotHairline().padding(.leading, 56)
            workspaceLink(
                title: "Tasks & Routines",
                symbol: "calendar.badge.clock",
                color: .orange,
                destination: TasksRoutinesView()
            )
            VBotHairline().padding(.leading, 56)
            workspaceLink(
                title: "Desktop engine",
                symbol: "cpu",
                color: .purple,
                destination: EngineSelectionView()
            )
        }
    }

    private var appearanceSection: some View {
        VBotSurfaceGroup(
            title: "Appearance",
            footer: "Adjusts message text, Markdown, tool details, and the composer without changing navigation or avatar sizes."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Conversation text size")
                    .font(.body)
                    .foregroundStyle(.primary)
                Picker("Conversation text size", selection: $conversationTextSize) {
                    Text("Small").tag(ConversationTextSize.small.rawValue)
                    Text("Standard").tag(ConversationTextSize.standard.rawValue)
                    Text("Large").tag(ConversationTextSize.large.rawValue)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var chatPreferencesSection: some View {
        VBotSurfaceGroup(
            title: "Chat",
            footer: "These preferences stay on this iPhone and do not change the desktop.") {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: globalShowToolActivity) {
                    Text("Show tool activity")
                        .font(.body)
                }
                Text(globalActivityCaption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            VBotHairline().padding(.leading, 16)

            VStack(alignment: .leading, spacing: 10) {
                Text("Chat intro")
                    .font(.body)
                Picker("Chat intro", selection: $islandIntro) {
                    ForEach(IslandIntro.allCases, id: \.rawValue) { intro in
                        Text(intro.label).tag(intro.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            VBotHairline().padding(.leading, 16)

            NavigationLink {
                QuickRepliesEditor()
            } label: {
                HStack(spacing: 12) {
                    SettingsIcon(symbol: "text.bubble", color: .blue)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Quick replies")
                        Text("Customize composer shortcuts")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var busySection: some View {
        VBotSurfaceGroup(
            title: "While agent is working",
            footer: "Steer sends your next message into the active turn. Queue holds it until the current work finishes. Touch and hold Send for either choice at any time."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Default action")
                    .font(.body)
                    .foregroundStyle(.primary)
                Picker("Default action", selection: $busySendDefault) {
                    Text("Steer").tag(BusySendDefault.steer.rawValue)
                    Text("Queue").tag(BusySendDefault.queue.rawValue)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var permissionsSection: some View {
        VBotSurfaceGroup(
            title: "Permissions",
            footer: "Applies to every bot unless that bot has its own setting. Safety checks, computer warnings, and questions are never bypassed."
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Picker("Permission behavior", selection: $permissionDefault) {
                    ForEach(PermissionMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .onChange(of: permissionDefault) { _, mode in
                    guard permissionPolicyLoaded else { return }
                    Task {
                        if let saved = await session.updatePermissionPolicy(mode) {
                            permissionDefault = saved.defaultMode
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var approvalReviewerSection: some View {
        VBotSurfaceGroup(
            title: ApprovalReviewerModelPolicy.sectionTitle,
            footer: approvalReviewerFooter
        ) {
            VStack(alignment: .leading, spacing: 10) {
                Text("When to summarize")
                    .font(.body)
                Picker("When to summarize", selection: approvalReviewerModeBinding) {
                    ForEach(ApprovalReviewerMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(!approvalReviewerLoaded)

                Text(ApprovalReviewerModelPolicy.sectionExplanation)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let reviewer = approvalReviewer, !reviewer.providers.isEmpty {
                    Picker("Reviewer provider", selection: approvalReviewerProviderBinding) {
                        ForEach(reviewer.providers, id: \.pickerId) { provider in
                            Text(provider.available ? provider.label : "\(provider.label) — unavailable")
                                .tag(provider.pickerId)
                        }
                    }
                    .pickerStyle(.menu)
                    .disabled(!approvalReviewerLoaded)
                    if let active = selectedReviewerProvider {
                        let compactModels = ApprovalReviewerModelPolicy.compactModels(
                            providerId: active.id,
                            models: active.models,
                            selectedModelId: modelId(in: active)
                        )
                        if compactModels.count > 1 {
                            Picker("Approval summary model", selection: approvalReviewerModelBinding) {
                                ForEach(compactModels) { model in
                                    Text(model.label).tag(model.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .disabled(!approvalReviewerLoaded || !active.available)
                        } else if let only = compactModels.first {
                            HStack {
                                Text("Summary model")
                                Spacer()
                                Text(only.label)
                                    .foregroundStyle(.secondary)
                            }
                            .font(.body)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var approvalReviewerFooter: String {
        if let reason = selectedReviewerProvider?.reason, selectedReviewerProvider?.available == false {
            return reason
        }
        return ApprovalReviewerModelPolicy.sectionExplanation
    }

    private var globalStoredActivityDetail: ActivityDetail {
        ActivityDetail(rawValue: activityDetail) ?? .reduced
    }

    private var globalShowToolActivity: Binding<Bool> {
        Binding(
            get: { ActivityDetailTogglePolicy.globalShowsToolActivity(globalStoredActivityDetail) },
            set: { show in
                activityDetail = ActivityDetailTogglePolicy.storedValuePreservingLegacyFull(
                    showToolActivity: show,
                    previous: globalStoredActivityDetail,
                    userChanged: true
                ).rawValue
            }
        )
    }

    private var globalActivityCaption: String {
        let stored = globalStoredActivityDetail
        let effective = stored == .full ? ActivityDetail.reduced : stored
        return effective.caption
    }

    private var selectedReviewerProvider: ApprovalReviewerProvider? {
        guard let reviewer = approvalReviewer else { return nil }
        if let selection = reviewer.selection {
            return reviewer.providers.first {
                $0.instanceId == selection.instanceId && $0.models.contains(where: { $0.id == selection.model })
            }
        }
        return reviewer.providers.first(where: \.available) ?? reviewer.providers.first
    }

    private var approvalReviewerModeBinding: Binding<ApprovalReviewerMode> {
        Binding(
            get: { approvalReviewer?.mode ?? .whenUnclear },
            set: { mode in
                guard approvalReviewerLoaded else { return }
                Task { await saveApprovalReviewer(mode: mode, provider: selectedReviewerProvider, modelId: selectedReviewerProvider.flatMap { modelId(in: $0) }) }
            }
        )
    }

    private var approvalReviewerProviderBinding: Binding<String> {
        Binding(
            get: { selectedReviewerProvider?.pickerId ?? "" },
            set: { pickerId in
                guard approvalReviewerLoaded, let reviewer = approvalReviewer,
                      let provider = reviewer.providers.first(where: { $0.pickerId == pickerId })
                else { return }
                Task { await saveApprovalReviewer(mode: reviewer.mode, provider: provider, modelId: provider.models.first?.id) }
            }
        )
    }

    private var approvalReviewerModelBinding: Binding<String> {
        Binding(
            get: { selectedReviewerProvider.flatMap { modelId(in: $0) } ?? "" },
            set: { modelId in
                guard approvalReviewerLoaded, let reviewer = approvalReviewer, let provider = selectedReviewerProvider else { return }
                Task { await saveApprovalReviewer(mode: reviewer.mode, provider: provider, modelId: modelId) }
            }
        )
    }

    private func modelId(in provider: ApprovalReviewerProvider) -> String? {
        if let selected = approvalReviewer?.selection, selected.instanceId == provider.instanceId,
           provider.models.contains(where: { $0.id == selected.model }) {
            return selected.model
        }
        return provider.models.first?.id
    }

    private func saveApprovalReviewer(mode: ApprovalReviewerMode, provider: ApprovalReviewerProvider?, modelId: String?) async {
        var patch = ApprovalReviewerPatch(mode: mode)
        if let provider, let modelId, provider.available {
            patch.instanceId = provider.instanceId
            patch.model = modelId
        }
        if let saved = await session.updateApprovalReviewer(patch) {
            approvalReviewer = saved
        }
    }

    private func workspaceLink<Destination: View>(
        title: String,
        symbol: String,
        color: Color,
        destination: Destination
    ) -> some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 12) {
                SettingsIcon(symbol: symbol, color: color)
                Text(title)
                    .font(.body)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var notificationsAreEnabled: Bool {
        switch session.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var notificationAccessibilityHint: String {
        if notificationsAreEnabled { return "Notifications are enabled" }
        if session.notificationAuthorization == .denied { return "Opens iPhone Settings" }
        return "Asks for permission to send notifications"
    }

    private var notificationRow: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "bell.fill", color: .red)
            Text("Notifications")
                .foregroundStyle(.primary)
            Spacer()
            if enablingNotifications {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(session.notificationStatusText)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: VBotSurface.Hit.minimum)
    }

    private var statusText: String { session.status.settingsText(previouslyLive: session.previouslyLive) }

    private var computerStatusText: String {
        guard session.connections.count > 1 else { return statusText }
        return "\(statusText) · \(session.connections.count) saved"
    }
}

private struct ComputerSettingsRow: View {
    let name: String
    let status: String
    let connected: Bool
    var showsChevron: Bool = true

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: VBotSurface.Radius.icon, style: .continuous)
                    .fill(MausPalette.color("blue").opacity(0.14))
                    .frame(width: 38, height: 38)
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(MausPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: VBotSurface.Radius.icon, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Saved computer switcher. Pairings stay on this phone and each token
/// remains isolated in Keychain; switching only changes the active stream.
struct ConnectedComputersView: View {
    @EnvironmentObject private var session: Session
    @State private var pendingRemoval: Connection?

    private var otherComputers: [Connection] {
        session.connections.filter { $0.id != session.connection?.id }
    }

    var body: some View {
        List {
            if let active = session.connection {
                Section(ConnectionPresentationPolicy.hubSectionTitle) {
                    NavigationLink {
                        ConnectionSecurityView()
                    } label: {
                        ComputerSettingsRow(
                            name: ConnectionPresentationPolicy.displayName(for: active),
                            status: session.status.settingsText(previouslyLive: session.previouslyLive),
                            connected: session.status == .live
                        )
                    }
                }
            }

            if !otherComputers.isEmpty {
                Section("Other computers") {
                    ForEach(otherComputers) { computer in
                        Button {
                            Haptics.selection()
                            session.switchComputer(to: computer.id)
                        } label: {
                            HStack(spacing: 12) {
                                ProfileAvatar(
                                    name: ConnectionPresentationPolicy.displayName(for: computer),
                                    size: 38
                                )
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(ConnectionPresentationPolicy.displayName(for: computer))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text("Tap to switch")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("Use")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(MausPalette.color("blue"))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Remove", role: .destructive) { pendingRemoval = computer }
                        }
                    }
                }
            }

            if session.bridgeRosterLoading {
                Section(ConnectionPresentationPolicy.bridgeSectionTitle) {
                    HStack {
                        ProgressView()
                        Text("Loading bridges…")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if !session.bridgeRoster.isEmpty {
                Section {
                    ForEach(BridgePresentationPolicy.present(session.bridgeRoster)) { bridge in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(bridge.displayName)
                                    .font(.body.weight(.medium))
                                if bridge.stale {
                                    Text(bridge.roleLabel.rawValue)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(Color.secondary.opacity(0.12), in: Capsule())
                                }
                                Spacer(minLength: 8)
                                Circle()
                                    .fill(bridge.entry.online ? Color.green : Color.secondary)
                                    .frame(width: 7, height: 7)
                                    .accessibilityHidden(true)
                                Text(BridgePresentationPolicy.onlineStatus(bridge.entry.online))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            if !bridge.stale {
                                Text(bridge.roleLabel.rawValue)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(BridgePresentationPolicy.capabilitySummary(bridge.entry.capabilities))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(BridgePresentationPolicy.accessibilityLabel(for: bridge))
                    }
                } header: {
                    Text(ConnectionPresentationPolicy.bridgeSectionTitle)
                } footer: {
                    Text(ConnectionPresentationPolicy.bridgeSectionFooter)
                }
            }

            Section {
                Button {
                    Haptics.selection()
                    session.beginPairing()
                } label: {
                    Label("Connect another computer", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Each computer is paired separately. Only the selected computer is active at a time.")
            }
        }
        .navigationTitle("Computers")
        .navigationBarTitleDisplayMode(.inline)
        .task { await session.refreshBridgeRoster() }
        .confirmationDialog(
            "Remove \(pendingRemoval.map { ConnectionPresentationPolicy.displayName(for: $0) } ?? "this computer")?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove from this iPhone", role: .destructive) {
                guard let pendingRemoval else { return }
                session.forgetConnection(id: pendingRemoval.id)
                self.pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("This removes the saved connection from this iPhone only.")
        }
    }
}

struct ConnectionSecurityView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var editingAddress = false
    @State private var editingName = false
    @State private var addressText = ""
    @State private var nameText = ""
    @State private var showingFullAddress = false
    @State private var copiedAddress = false
    @State private var refreshing = false

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                if let connection = session.connection {
                    identityCard(connection)
                    detailsCard(connection)
                    troubleshootingCard
                    signOutCard
                } else {
                    ContentUnavailableView("No computer connected", systemImage: "laptopcomputer.slash")
                        .frame(minHeight: 220)
                }
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, VBotSurface.Space.section)
            .padding(.bottom, 36)
        }
        .navigationTitle("Connection & Security")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
        .alert("Edit address", isPresented: $editingAddress) {
            TextField("Computer address", text: $addressText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") {
                if !session.updateAddress(addressText) {
                    session.actionError = "That address doesn't look right. Copy it from Phone settings and try again."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Use the address shown in Phone settings on your computer. Your pairing is kept.")
        }
        .alert("Rename computer", isPresented: $editingName) {
            TextField("Friendly name", text: $nameText)
            Button("Save") {
                guard let connection = session.connection else { return }
                session.renameConnection(id: connection.id, alias: nameText)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This name stays on your iPhone and does not change pairing or security.")
        }
        .confirmationDialog(
            "Remove this connection?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Remove from this iPhone", role: .destructive) {
                session.signOut()
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the connection from this iPhone only. It does not revoke this phone on your Mac. To remove Mac-side access, open V Bot → Settings → Phone and remove this device.")
        }
    }

    private func identityCard(_ connection: Connection) -> some View {
        HStack(spacing: 14) {
            ProfileAvatar(
                name: ConnectionPresentationPolicy.displayName(for: connection),
                size: 46
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(ConnectionPresentationPolicy.displayName(for: connection))
                    .font(.headline)
                Label(session.status.settingsText(previouslyLive: session.previouslyLive),
                      systemImage: session.status == .live ? "checkmark.circle.fill" : "circle.dotted")
                    .font(.subheadline)
                    .foregroundStyle(session.status == .live ? Color.green : Color.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(minHeight: VBotSurface.Hit.row)
        .vbotCard()
        .accessibilityElement(children: .combine)
    }

    private func detailsCard(_ connection: Connection) -> some View {
        VBotSurfaceGroup {
            DisclosureGroup("Connection details") {
                VStack(alignment: .leading, spacing: 12) {
                    Group {
                        if showingFullAddress {
                            Text(connection.displayAddress)
                                .textSelection(.enabled)
                        } else {
                            Text(shortened(connection.displayAddress))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)

                    HStack(spacing: 16) {
                        Button(showingFullAddress ? "Hide full address" : "Show full address") {
                            showingFullAddress.toggle()
                        }
                        .frame(minHeight: VBotSurface.Hit.minimum)
                        Button(copiedAddress ? "Copied" : "Copy") {
                            PlatformBridge.copyToPasteboard(connection.displayAddress)
                            copiedAddress = true
                            Task {
                                try? await Task.sleep(for: .seconds(2))
                                copiedAddress = false
                            }
                        }
                        .frame(minHeight: VBotSurface.Hit.minimum)
                    }
                    .font(.subheadline.weight(.medium))
                }
                .padding(.top, 10)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            VBotHairline().padding(.leading, 16)

            Button("Rename") {
                if let connection = session.connection {
                    nameText = ConnectionPresentationPolicy.displayName(for: connection)
                    editingName = true
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)

            Button("Edit address") {
                addressText = connection.displayAddress
                editingAddress = true
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var troubleshootingCard: some View {
        VBotSurfaceGroup(title: "Troubleshooting") {
            Text(troubleshootingText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 8)

            VBotHairline().padding(.leading, 16)

            Button {
                refreshing = true
                Task {
                    await session.refresh()
                    refreshing = false
                }
            } label: {
                HStack {
                    Text("Try reconnecting")
                    if refreshing {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(refreshing)
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.row)
        }
    }

    private var signOutCard: some View {
        Button("Remove connection from this iPhone", role: .destructive) {
            confirmingSignOut = true
        }
        .frame(maxWidth: .infinity, minHeight: VBotSurface.Hit.row)
        .vbotCard()
    }

    private var troubleshootingText: String {
        switch session.status {
        case .live:
            return "This computer is connected and responding normally."
        case .connecting:
            return session.previouslyLive
                ? "Reconnecting automatically. Cached chats stay available."
                : "V Bot is trying the saved connection automatically."
        case let .offline(reason):
            return reason
        case .unauthorized:
            return "This phone was removed from the computer. Pair it again to reconnect."
        case .unpaired:
            return "This phone is not paired with a computer."
        }
    }

    private func shortened(_ address: String) -> String {
        guard address.count > 14 else { return address }
        let leadingCount = min(20, max(8, address.count - 8))
        return "\(address.prefix(leadingCount))…\(address.suffix(6))"
    }
}

private extension Session.Status {
    var settingsText: String {
        settingsText(previouslyLive: false)
    }

    func settingsText(previouslyLive: Bool) -> String {
        switch self {
        case .live: return "Connected"
        case .connecting: return previouslyLive
            ? ConnectionResiliencePolicy.reconnectingCopy
            : ConnectionResiliencePolicy.connectingCopy
        case .unpaired: return "Not paired"
        case .unauthorized: return "Needs pairing"
        case .offline: return "Offline"
        }
    }

    private func routeDescription(for connection: Connection) -> String {
        switch connection.activeEndpoint?.kind {
        case .hosted: return "HTTPS"
        case .tailnet: return "Tailscale"
        case .lan: return "Local network"
        case .bonjour: return "Bonjour"
        case nil: return "Legacy local"
        }
    }
}

/// The compact account sheet behind the roster avatar. Keep this menu
/// lightweight: account identity and plugins first, detailed controls one tap
/// deeper in Settings.
struct AccountSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    private let onOpenChat: ((Chat) -> Void)?

    init(onOpenChat: ((Chat) -> Void)? = nil) {
        self.onOpenChat = onOpenChat
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: VBotSurface.Space.row) {
                    accountRow
                    if session.connection != nil {
                        NavigationLink {
                            ConnectedComputersView()
                        } label: {
                            rowLabel(
                                title: "Computers",
                                subtitle: fleetSubtitle,
                                systemImage: "laptopcomputer.and.iphone"
                            )
                        }
                    }
                    NavigationLink {
                        ConnectedAppsView()
                    } label: {
                        rowLabel(
                            title: "Connected apps",
                            subtitle: "Connectors and accounts your bots can use",
                            systemImage: "link"
                        )
                    }
                    if session.connection != nil {
                        NavigationLink {
                            HiddenChatsView()
                        } label: {
                            rowLabel(
                                title: "Hidden chats",
                                subtitle: "Bots you removed from the roster",
                                systemImage: "eye.slash"
                            )
                        }
                    }
                    NavigationLink {
                        SettingsView(onOpenChat: onOpenChat)
                    } label: {
                        rowLabel(
                            title: "Settings",
                            subtitle: "Connection, notifications, and appearance",
                            systemImage: "gearshape"
                        )
                    }
                }
                .padding(VBotSurface.Space.page)
            }
            .vbotCanvas()
            .navigationTitle(" ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var accountRow: some View {
        NavigationLink {
            AccountProfileView()
        } label: {
            HStack(spacing: 14) {
                AccountAvatar(size: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your profile")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.primary)
                    Text("Choose your avatar icon")
                        .font(.subheadline)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.secondary)
                    .accessibilityHidden(true)
            }
            .padding(16)
            .vbotCard()
        }
        .buttonStyle(.plain)
    }

    private var fleetSubtitle: String {
        let summary = ConnectionPresentationPolicy.fleetSummary(count: session.connections.count)
        guard let connection = session.connection else { return summary }
        let current = ConnectionPresentationPolicy.displayName(for: connection)
        return "\(summary) · \(current) active"
    }

    private func rowLabel(title: String, subtitle: String, systemImage: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.secondary)
                .accessibilityHidden(true)
        }
        .padding(16)
        .frame(minHeight: VBotSurface.Hit.row)
        .vbotCard()
    }
}

struct AccountProfileView: View {
    @AppStorage(PrefKey.accountAvatarSymbol) private var storedSymbol = AccountAvatarSymbol.person.rawValue
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                AccountAvatar(size: 88)
                    .padding(.top, 12)

                VStack(spacing: 6) {
                    Text("Your avatar")
                        .font(.title2.weight(.semibold))
                    Text("This stays on your iPhone and represents you across V Bot.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(AccountAvatarSymbol.allCases) { option in
                        Button {
                            Haptics.selection()
                            storedSymbol = option.rawValue
                        } label: {
                            VStack(spacing: 9) {
                                Image(systemName: option.rawValue)
                                    .font(.system(size: 22, weight: .semibold))
                                    .frame(width: 46, height: 46)
                                    .foregroundStyle(option.rawValue == storedSymbol ? .white : Color.primary)
                                    .background(
                                        option.rawValue == storedSymbol
                                            ? MausPalette.color("green")
                                            : Color.secondary.opacity(0.12),
                                        in: Circle()
                                    )
                                Text(option.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .vbotCard()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Use \(option.label) avatar")
                        .accessibilityAddTraits(option.rawValue == storedSymbol ? .isSelected : [])
                    }
                }
            }
            .padding(VBotSurface.Space.page)
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
    }
}

struct EngineSelectionView: View {
    @EnvironmentObject private var session: Session
    @State private var sync: VBotEngineSync?
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var loadGeneration = 0

    private var canEdit: Bool {
        CalmSurfacePolicy.canEditRemoteContent(
            isLive: session.status == .live,
            hasConnection: session.connection != nil
        )
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                if CalmSurfacePolicy.showsSkeleton(isLoading: loading, hasCachedRows: sync != nil) {
                    VBotSurfaceGroup {
                        CalmSkeletonList(rows: 4, label: "Loading engines")
                    }
                } else if let sync {
                    if !canEdit {
                        ReconnectToEditBanner()
                    }
                    enginePicker(sync)
                    engineStatus(sync)
                    if !sync.bots.isEmpty { syncedAgents(sync) }
                    if !sync.groups.isEmpty { syncedGroups(sync) }
                    if let router = sync.router, sync.reconstructedMutationsReady {
                        hostProvider(router)
                    }
                    if let error {
                        VBotSurfaceGroup {
                            Text(error)
                                .foregroundStyle(.secondary)
                                .padding(16)
                            VBotHairline().padding(.leading, 16)
                            Button("Try again") { Task { await load() } }
                                .padding(.horizontal, 16)
                                .frame(minHeight: VBotSurface.Hit.row)
                        }
                    }
                } else if let error {
                    VBotSurfaceGroup {
                        Text(error)
                            .foregroundStyle(.secondary)
                            .padding(16)
                        VBotHairline().padding(.leading, 16)
                        Button("Try again") { Task { await load() } }
                            .padding(.horizontal, 16)
                            .frame(minHeight: VBotSurface.Hit.row)
                    }
                }
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, VBotSurface.Space.section)
            .padding(.bottom, 36)
        }
        .navigationTitle("Desktop engine")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
        .task { await load() }
    }

    private func enginePicker(_ sync: VBotEngineSync) -> some View {
        VBotSurfaceGroup(footer: engineFooter(sync)) {
            ForEach(Array(VBotPrimaryEngine.allCases.enumerated()), id: \.element.id) { index, engine in
                Button {
                    guard canEdit, !saving else { return }
                    Task { await save(engine: engine) }
                } label: {
                    HStack {
                        Text(engine.displayName)
                            .foregroundStyle(.primary)
                        Spacer()
                        if sync.selectedEngine == engine {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: VBotSurface.Hit.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(saving || !canEdit)
                if index < VBotPrimaryEngine.allCases.count - 1 {
                    VBotHairline().padding(.leading, 16)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Primary engine")
    }

    private func engineFooter(_ sync: VBotEngineSync) -> String {
        if sync.fallback, let reason = sync.fallbackReason {
            return "Using OpenMaus because Grok Reconstructed is unavailable: \(reason)"
        }
        if sync.servingEngine == .grokReconstructed {
            return "V Bot is showing agents synced from Grok Bot 0.18 Reconstructed on this Mac."
        }
        return "OpenMaus remains the default engine when Grok Reconstructed is unavailable."
    }

    private func engineStatus(_ sync: VBotEngineSync) -> some View {
        VBotSurfaceGroup(title: "Engine status") {
            ForEach(Array(sync.engines.enumerated()), id: \.element.id) { index, engine in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(engine.displayName)
                        Spacer()
                        Text(engine.isAvailable ? "Available" : "Unavailable")
                            .foregroundStyle(engine.isAvailable ? .green : .secondary)
                    }
                    if let reason = engine.reason, !engine.isAvailable {
                        Text(reason)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(minHeight: VBotSurface.Hit.minimum)
                if index < sync.engines.count - 1 {
                    VBotHairline().padding(.leading, 16)
                }
            }
        }
    }

    private func syncedAgents(_ sync: VBotEngineSync) -> some View {
        VBotSurfaceGroup(title: "Synced agents") {
            ForEach(Array(sync.bots.enumerated()), id: \.element.id) { index, bot in
                HStack {
                    Text(bot.label)
                    Spacer()
                    if bot.busy == true {
                        Text("Working")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 16)
                .frame(minHeight: VBotSurface.Hit.row)
                if index < sync.bots.count - 1 {
                    VBotHairline().padding(.leading, 16)
                }
            }
        }
    }

    private func syncedGroups(_ sync: VBotEngineSync) -> some View {
        VBotSurfaceGroup(title: "Synced groups") {
            ForEach(Array(sync.groups.enumerated()), id: \.element.id) { index, group in
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.label)
                    if !group.memberIds.isEmpty {
                        Text("\(group.memberIds.count) member\(group.memberIds.count == 1 ? "" : "s")")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(minHeight: VBotSurface.Hit.row)
                if index < sync.groups.count - 1 {
                    VBotHairline().padding(.leading, 16)
                }
            }
        }
    }

    private func hostProvider(_ router: VBotRouterState) -> some View {
        let models: [VBotProviderModel] = {
            guard let current = router.providers.first(where: { $0.id == router.selected.provider }) else { return [] }
            return current.models.filter { $0.selectable || $0.id == router.selected.modelId }
        }()
        return VBotSurfaceGroup(
            title: "Host provider",
            footer: ModelSelectionPolicy.hostWideHint
        ) {
            ReconstructedProviderPicker(
                providers: router.providers,
                selectedProvider: router.selected.provider,
                selectedModelId: router.selected.modelId,
                models: models,
                disabled: saving || !canEdit,
                onProviderChange: { provider in
                    Task { await saveRouter(provider: provider, modelId: nil) }
                },
                onModelChange: { modelId in
                    Task { await saveRouter(provider: router.selected.provider, modelId: modelId) }
                }
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    private func load() async {
        let hadCache = sync != nil || session.engineSync != nil
        if sync == nil { sync = session.engineSync }
        if !hadCache { loading = true }
        defer { loading = false }
        loadGeneration = EngineSyncPolicy.nextGeneration(after: loadGeneration)
        let generation = loadGeneration
        guard session.connection != nil else {
            if sync == nil {
                error = "Connect to your computer to choose an engine."
            }
            return
        }
        if let loaded = await session.loadEngineSync() {
            guard EngineSyncPolicy.shouldApply(startedGeneration: generation, currentGeneration: loadGeneration) else { return }
            sync = loaded
            error = nil
        } else if sync == nil {
            error = session.actionError ?? "Could not load engine status."
        }
    }

    private func save(engine: VBotPrimaryEngine) async {
        saving = true
        defer { saving = false }
        if let updated = await session.setPrimaryEngine(engine) {
            sync = updated
            error = nil
        } else {
            error = session.actionError ?? "Could not update the primary engine."
        }
    }

    private func saveRouter(provider: String, modelId: String?) async {
        saving = true
        defer { saving = false }
        if let router = await session.setReconstructedRouter(provider: provider, modelId: modelId) {
            if var current = sync {
                current.router = router
                sync = current
            }
            error = nil
        } else {
            error = session.actionError ?? "Could not update the reconstructed provider."
        }
    }
}
