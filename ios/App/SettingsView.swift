// Settings stays status-first. Network details and destructive pairing
// controls live one level deeper so the everyday screen remains calm.
import SwiftUI
import CompanionCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @AppStorage("conversationTextSize") private var conversationTextSize = ConversationTextSize.standard.rawValue
    @AppStorage("busySendDefault") private var busySendDefault = BusySendDefault.steer.rawValue
    @State private var enablingNotifications = false
    private let onConnect: (() -> Void)?

    init(onConnect: (() -> Void)? = nil) {
        self.onConnect = onConnect
    }

    var body: some View {
        Form {
            Section("Computer") {
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
                } else {
                    Button {
                        onConnect?()
                    } label: {
                        ComputerSettingsRow(
                            name: "Connect a computer",
                            status: "Not connected",
                            connected: false
                        )
                    }
                    .disabled(onConnect == nil)
                }
            }

            Section {
                if notificationsAreEnabled {
                    notificationRow
                        .accessibilityHint(notificationAccessibilityHint)
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
                    .disabled(enablingNotifications)
                    .accessibilityHint(notificationAccessibilityHint)
                }
            } footer: {
                Text("Alerts arrive while V Bot is open or was recently in the background. Closed-app delivery is not available yet.")
            }

            if session.connection != nil {
                Section("Workspace") {
                    NavigationLink {
                        TasksRoutinesView()
                    } label: {
                        Label {
                            Text("Tasks & Routines")
                        } icon: {
                            SettingsIcon(symbol: "calendar.badge.clock", color: .orange)
                        }
                    }

                    NavigationLink {
                        ConnectedAppsView()
                    } label: {
                        Label {
                            Text("Connected Apps")
                        } icon: {
                            SettingsIcon(symbol: "link", color: .blue)
                        }
                    }

                    NavigationLink {
                        EngineSelectionView()
                    } label: {
                        Label {
                            Text("Desktop engine")
                        } icon: {
                            SettingsIcon(symbol: "cpu", color: .purple)
                        }
                    }
                }

                Section {
                    Picker("Conversation text size", selection: $conversationTextSize) {
                        Text("Small").tag(ConversationTextSize.small.rawValue)
                        Text("Standard").tag(ConversationTextSize.standard.rawValue)
                        Text("Large").tag(ConversationTextSize.large.rawValue)
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Adjusts message text, Markdown, tool details, and the composer without changing navigation or avatar sizes.")
                }

                Section {
                    Picker("Default action", selection: $busySendDefault) {
                        Text("Steer").tag(BusySendDefault.steer.rawValue)
                        Text("Queue").tag(BusySendDefault.queue.rawValue)
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("While agent is working")
                } footer: {
                    Text("Steer sends your next message into the active turn. Queue holds it until the current work finishes. Touch and hold Send for either choice at any time.")
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(VBotSurface.background.ignoresSafeArea())
        .task { await session.refreshNotificationAuthorization() }
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
    }

    private var statusText: String { session.status.settingsText }
}

private struct ComputerSettingsRow: View {
    let name: String
    let status: String
    let connected: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(MausPalette.color("blue").opacity(0.14))
                    .frame(width: 38, height: 38)
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(MausPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(name)
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
        }
        .padding(.vertical, 2)
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
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
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
        Form {
            if let connection = session.connection {
                Section {
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
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section {
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
                                Button(copiedAddress ? "Copied" : "Copy") {
                                    UIPasteboard.general.string = connection.displayAddress
                                    copiedAddress = true
                                    Task {
                                        try? await Task.sleep(for: .seconds(2))
                                        copiedAddress = false
                                    }
                                }
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .padding(.top, 10)
                    }

                    Button("Edit address") {
                        addressText = connection.displayAddress
                        editingAddress = true
                    }
                }

                Section("Troubleshooting") {
                    Text(troubleshootingText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

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
                }

                Section {
                    Button("Remove connection from this iPhone", role: .destructive) {
                        confirmingSignOut = true
                    }
                }
            } else {
                ContentUnavailableView("No computer connected", systemImage: "laptopcomputer.slash")
            }
        }
        .navigationTitle("Connection & Security")
        .navigationBarTitleDisplayMode(.inline)
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
                VStack(spacing: 12) {
                    accountRow
                    NavigationLink {
                        ConnectedAppsView()
                    } label: {
                        rowLabel(
                            title: "Plugins",
                            subtitle: "Tools and skills for your agents",
                            systemImage: "puzzlepiece.extension"
                        )
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
                .padding(20)
            }
            .background(AccountSheetStyle.canvas.ignoresSafeArea())
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
                ProfileAvatar(name: session.connection?.name ?? "You", size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.connection?.name ?? "Vincent Posival")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    Text(session.connection?.pairingConsentOrigin ?? "Paired computer")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(16)
            .background(AccountSheetStyle.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color.primary)
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.secondary)
        }
        .padding(16)
        .background(AccountSheetStyle.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private enum AccountSheetStyle {
    static let canvas = VBotSurface.background
    static let card = VBotSurface.card
}

struct EngineSelectionView: View {
    @EnvironmentObject private var session: Session
    @State private var sync: VBotEngineSync?
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        Form {
            if loading {
                Section {
                    ProgressView("Loading engines…")
                }
            } else if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await load() } }
                }
            } else if let sync {
                Section {
                    Picker("Primary engine", selection: Binding(
                        get: { sync.selectedEngine },
                        set: { newEngine in Task { await save(engine: newEngine) } }
                    )) {
                        ForEach(VBotPrimaryEngine.allCases) { engine in
                            Text(engine.displayName).tag(engine)
                        }
                    }
                    .disabled(saving)
                } footer: {
                    if sync.fallback, let reason = sync.fallbackReason {
                        Text("Using OpenMaus because Grok Reconstructed is unavailable: \(reason)")
                    } else if sync.servingEngine == .grokReconstructed {
                        Text("V Bot is showing agents synced from Grok Bot 0.18 Reconstructed on this Mac.")
                    } else {
                        Text("OpenMaus remains the default engine when Grok Reconstructed is unavailable.")
                    }
                }

                Section("Engine status") {
                    ForEach(sync.engines, id: \.id) { engine in
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
                    }
                }

                if !sync.bots.isEmpty {
                    Section("Synced agents") {
                        ForEach(sync.bots) { bot in
                            HStack {
                                Text(bot.label)
                                Spacer()
                                if bot.busy == true {
                                    Text("Working")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if !sync.groups.isEmpty {
                    Section("Synced groups") {
                        ForEach(sync.groups) { group in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.label)
                                if !group.memberIds.isEmpty {
                                    Text("\(group.memberIds.count) member\(group.memberIds.count == 1 ? "" : "s")")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if let router = sync.router, sync.reconstructedMutationsReady {
                    Section {
                        Picker("Provider", selection: Binding(
                            get: { router.selected.provider },
                            set: { provider in Task { await saveRouter(provider: provider, modelId: nil) } }
                        )) {
                            ForEach(router.providers.filter(\.selectable)) { provider in
                                Text(provider.label).tag(provider.id)
                            }
                            if router.providers.contains(where: { $0.id == router.selected.provider && $0.selectable }) == false {
                                Text(router.selected.provider).tag(router.selected.provider)
                            }
                        }
                        .disabled(saving)
                        if router.selected.provider == "cursor" {
                            cursorModelPicker(router: router)
                        } else {
                            Text("Only Cursor models can be changed here. Other providers keep their local model.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("Host provider")
                    } footer: {
                        Text("This selection is host-wide on Grok Reconstructed, not per agent.")
                    }
                }
            }
        }
        .navigationTitle("Desktop engine")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(VBotSurface.background.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        guard session.connection != nil else {
            error = "Connect to your computer to choose an engine."
            sync = nil
            return
        }
        if let loaded = await session.loadEngineSync() {
            sync = loaded
            error = nil
        } else {
            error = session.actionError ?? "Could not load engine status."
            sync = nil
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
        return Picker("Cursor model", selection: Binding(
            get: { router.selected.modelId },
            set: { modelId in Task { await saveRouter(provider: "cursor", modelId: modelId) } }
        )) {
            ForEach(models, id: \.id) { model in
                Text(model.id).tag(model.id)
            }
        }
        .disabled(saving)
    }
}
