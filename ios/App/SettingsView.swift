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
    @State private var enablingNotifications = false
    private let onConnect: (() -> Void)?

    init(onConnect: (() -> Void)? = nil) {
        self.onConnect = onConnect
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                computerSection
                notificationsSection
                hapticsSection
                if session.connection != nil {
                    workspaceSection
                    appearanceSection
                    busySection
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
        .task { await session.refreshNotificationAuthorization() }
    }

    private var computerSection: some View {
        VBotSurfaceGroup(title: "Computer") {
            if let connection = session.connection {
                NavigationLink {
                    ConnectionSecurityView()
                } label: {
                    ComputerSettingsRow(
                        name: connection.name,
                        status: statusText,
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
            footer: "Alerts arrive while V Bot is open or was recently in the background. Closed-app delivery is not available yet."
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
                title: "Connected Apps",
                symbol: "link",
                color: .blue,
                destination: ConnectedAppsView()
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

    private var statusText: String { session.status.settingsText }
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

struct ConnectionSecurityView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var editingAddress = false
    @State private var addressText = ""
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
            Text("This removes the connection from this iPhone only. It does not revoke this phone on your Mac. To remove Mac-side access, open OpenMausBot → Settings → Phone and remove this device.")
        }
    }

    private func identityCard(_ connection: Connection) -> some View {
        HStack(spacing: 14) {
            ProfileAvatar(name: connection.name, size: 46)
            VStack(alignment: .leading, spacing: 4) {
                Text(connection.name)
                    .font(.headline)
                Label(session.status.settingsText,
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
            return "OpenMausBot is trying the saved connection automatically."
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
        switch self {
        case .live: return "Connected"
        case .connecting: return "Connecting…"
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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: VBotSurface.Space.row) {
                    accountRow
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
                        SettingsView()
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
            SettingsView()
        } label: {
            HStack(spacing: 14) {
                ProfileAvatar(name: session.connection?.name ?? "You", size: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.connection?.name ?? "You")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.primary)
                    Text(session.connection?.pairingConsentOrigin ?? "Paired computer")
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

struct EngineSelectionView: View {
    @EnvironmentObject private var session: Session
    @State private var sync: VBotEngineSync?
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

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
        let selectableProviders = router.providers.filter(\.selectable)
        return VBotSurfaceGroup(
            title: "Host provider",
            footer: "This selection is host-wide on Grok Reconstructed, not per agent."
        ) {
            ForEach(Array(selectableProviders.enumerated()), id: \.element.id) { index, provider in
                Button {
                    guard canEdit, !saving else { return }
                    Task { await saveRouter(provider: provider.id, modelId: nil) }
                } label: {
                    HStack {
                        Text(provider.label)
                            .foregroundStyle(.primary)
                        Spacer()
                        if router.selected.provider == provider.id {
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
                if index < selectableProviders.count - 1 {
                    VBotHairline().padding(.leading, 16)
                }
            }
            if router.providers.contains(where: { $0.id == router.selected.provider && $0.selectable }) == false {
                HStack {
                    Text(router.selected.provider)
                        .foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: VBotSurface.Hit.row)
            }
            if router.selected.provider == "cursor" {
                VBotHairline().padding(.leading, 16)
                cursorModelPicker(router: router)
                    .padding(.horizontal, 16)
            } else {
                VBotHairline().padding(.leading, 16)
                Text("Only Cursor models can be changed here. Other providers keep their local model.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(16)
            }
        }
    }

    private func load() async {
        let hadCache = sync != nil
        if !hadCache { loading = true }
        defer { loading = false }
        guard session.connection != nil else {
            if sync == nil {
                error = "Connect to your computer to choose an engine."
            }
            return
        }
        if let loaded = await session.loadEngineSync() {
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

    private func selectableCursorModels(for router: VBotRouterState) -> [VBotProviderModel] {
        guard let cursor = router.providers.first(where: { $0.id == "cursor" }) else { return [] }
        return cursor.models.filter { $0.selectable || $0.id == router.selected.modelId }
    }

    private func cursorModelPicker(router: VBotRouterState) -> some View {
        let models = selectableCursorModels(for: router)
        return VStack(spacing: 0) {
            ForEach(Array(models.enumerated()), id: \.element.id) { index, model in
                Button {
                    guard canEdit, !saving else { return }
                    Task { await saveRouter(provider: "cursor", modelId: model.id) }
                } label: {
                    HStack {
                        Text(model.id)
                            .foregroundStyle(.primary)
                        Spacer()
                        if router.selected.modelId == model.id {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .frame(minHeight: VBotSurface.Hit.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(saving || !canEdit)
                if index < models.count - 1 {
                    VBotHairline()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Cursor model")
    }
}
