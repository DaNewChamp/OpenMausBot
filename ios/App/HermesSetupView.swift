import SwiftUI
import CompanionCore

/// First-party Hermes setup, intentionally separate from the reconstructed
/// engine picker. The screen only renders the safe setup projection returned
/// by the paired V Bot computer.
struct HermesSetupView: View {
    let onOpenChat: ((Chat) -> Void)?

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var status: HermesSetupStatus?
    @State private var loading = true
    @State private var connecting = false
    @State private var connectTask: Task<Void, Never>?
    @State private var pendingConversion: HermesEndpointOption?

    init(onOpenChat: ((Chat) -> Void)? = nil) {
        self.onOpenChat = onOpenChat
    }

    private var presentation: HermesSetupPresentation {
        HermesSetupPresentationPolicy.presentation(
            status: status,
            isLoading: loading || connecting
        )
    }

    private var availableProfiles: [HermesSetupProfile] {
        guard let status else { return [] }
        return HermesSetupPresentationPolicy.availableProfiles(status)
    }

    private var connectedProfiles: [HermesSetupProfile] {
        status?.profiles.filter { $0.botId?.isEmpty == false } ?? []
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                stateCard
                if !loading, !connecting {
                    profileContent
                }
                placementCard
                defaultRuntimeCard
                capabilitiesCard
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, VBotSurface.Space.section)
            .padding(.bottom, 36)
        }
        .navigationTitle("Hermes")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
        .task { await loadStatus() }
        .onDisappear {
            connectTask?.cancel()
            connectTask = nil
        }
        .sheet(item: $pendingConversion) { endpoint in
            conversionSheet(endpoint)
        }
    }

    private var stateCard: some View {
        VBotSurfaceGroup {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: iconName)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(iconColor)
                        .frame(width: 38, height: 38)
                        .background(iconColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(presentation.title)
                            .font(.headline)
                        if loading || connecting {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                    Spacer(minLength: 0)
                }

                Text(presentation.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                if let actionTitle = topActionTitle {
                    Button(actionTitle) {
                        if presentation.state == .ready {
                            connectDefaultOrShowProfiles()
                        } else {
                            Task { await loadStatus() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(loading || connecting)
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var profileContent: some View {
        if presentation.state == .connected, !connectedProfiles.isEmpty {
            VBotSurfaceGroup(title: "Connected profiles") {
                ForEach(connectedProfiles) { profile in
                    profileRow(profile, actionTitle: "Open chat") {
                        openChat(for: profile)
                    }
                    if profile.id != connectedProfiles.last?.id {
                        VBotHairline().padding(.leading, 16)
                    }
                }
            }
        } else if presentation.state == .ready,
                  HermesSetupPresentationPolicy.shouldShowProfileList(status ?? HermesSetupStatus()) {
            ForEach(placementGroups, id: \.label) { group in
                VBotSurfaceGroup(title: group.label) {
                    ForEach(group.profiles) { profile in
                        profileRow(profile, actionTitle: connectLabel(for: profile)) {
                            connect(profile: profile)
                        }
                        if profile.id != group.profiles.last?.id {
                            VBotHairline().padding(.leading, 16)
                        }
                    }
                }
            }
        } else if presentation.state == .ready, availableProfiles.isEmpty {
            VBotSurfaceGroup {
                Text("Hermes is ready, but no profiles are available yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(16)
            }
        }
    }

    private var placementGroups: [HermesSetupPresentationPolicy.HermesSetupPlacementGroup] {
        guard let status else { return [] }
        return HermesSetupPresentationPolicy.profilesGroupedByPlacement(
            status,
            computerName: session.connection?.name
        )
    }

    private var placementCard: some View {
        Group {
            if let status, HermesSetupPresentationPolicy.hasRemotePlacements(status) {
                Text("Profiles on paired computers appear by computer name. Hermes credentials and bridge ids never leave the hub.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            } else {
                Text("Hermes connects directly on this computer. For another machine, pair that V Bot first, then connect Hermes there.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }
        }
    }

    private var hermesEndpoints: [HermesEndpointOption] {
        guard let status else { return [] }
        let computer = session.connection?.name ?? "This computer"
        return HermesSetupPresentationPolicy.availableProfiles(status).map { profile in
            let placement = profile.placement
            let name: String
            if placement?.kind == .bridge {
                name = {
                    let bridge = placement?.bridge?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    return bridge.isEmpty ? "Remote computer" : bridge
                }()
            } else {
                name = computer
            }
            return HermesEndpointOption(
                id: profile.id,
                computerName: name,
                profile: profile.profile
            )
        }
    }

    private var defaultRuntimeCard: some View {
        VBotSurfaceGroup(title: "Default Hermes runtime") {
            VStack(alignment: .leading, spacing: 10) {
                if let current = session.defaultHermesEndpoint() {
                    Text(current.label)
                        .font(.body.weight(.medium))
                } else {
                    Text("No default selected")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                ForEach(hermesEndpoints) { endpoint in
                    Button(endpoint.label) {
                        session.setDefaultHermesEndpoint(endpoint)
                    }
                    .disabled(session.defaultHermesEndpoint()?.id == endpoint.id)
                }
            }
            .padding(16)
        }
    }

    private var capabilitiesCard: some View {
        let manifest = status?.nativeCapabilities ?? HermesNativeCapabilityManifest()
        return VBotSurfaceGroup(title: "Hermes capabilities") {
            VStack(alignment: .leading, spacing: 8) {
                capabilityRow("Memory", key: "memory", manifest: manifest)
                capabilityRow("Learning", key: "learning", manifest: manifest)
                capabilityRow("Skills", key: "skills", manifest: manifest)
                capabilityRow("MoA", key: "moa", manifest: manifest)
                capabilityRow("Groups", key: "groups", manifest: manifest)
                capabilityRow("Computer tools", key: "computerTools", manifest: manifest)
            }
            .padding(16)
        }
    }

    private func capabilityRow(_ title: String, key: String, manifest: HermesNativeCapabilityManifest) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(HermesRuntimePresentationPolicy.availabilityLabel(for: key, in: manifest))
                .foregroundStyle(HermesRuntimePresentationPolicy.isEnabled(key, in: manifest) ? Color.secondary : Color.orange)
        }
        .font(.subheadline)
        .disabled(!HermesRuntimePresentationPolicy.isEnabled(key, in: manifest))
    }

    private func conversionSheet(_ endpoint: HermesEndpointOption) -> some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(HermesRuntimePresentationPolicy.conversionSummary(
                    botName: "This bot",
                    sourceLabel: "Current runtime",
                    destinationLabel: endpoint.label
                ))
                Text("Name, avatar, rooms, history, and fleet grants stay. A restart may be required.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding()
            .navigationTitle("Convert runtime")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { pendingConversion = nil }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func profileRow(
        _ profile: HermesSetupProfile,
        actionTitle: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(profile.displayName.isEmpty ? profile.handle : profile.displayName)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let subtitle = profileSubtitle(profile) {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Text(profile.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Text(actionTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(connecting)
    }

    private func connectDefaultOrShowProfiles() {
        guard let status else {
            connect(profile: nil)
            return
        }
        if HermesSetupPresentationPolicy.shouldShowProfileList(status) {
            return
        }
        connect(profile: HermesSetupPresentationPolicy.defaultProfile(status))
    }

    private var topActionTitle: String? {
        guard let actionTitle = presentation.actionTitle else { return nil }
        if presentation.state == .ready,
           let status,
           HermesSetupPresentationPolicy.requiresProfileChoice(status) {
            return nil
        }
        return actionTitle
    }

    private func connectLabel(for profile: HermesSetupProfile) -> String {
        if HermesSetupPresentationPolicy.defaultProfile(status ?? HermesSetupStatus())?.id == profile.id {
            return "Connect"
        }
        return "Use"
    }

    private func openChat(for profile: HermesSetupProfile) {
        guard HermesSetupPresentationPolicy.profileAction(profile) == .openChat,
              let chat = profile.botId.flatMap(session.hermesChat(forBotID:)) else {
            session.actionError = "This Hermes chat is no longer available. Refresh Hermes and try again."
            return
        }
        if let onOpenChat {
            onOpenChat(chat)
        } else {
            dismiss()
        }
    }

    private func profileSubtitle(_ profile: HermesSetupProfile) -> String? {
        guard let placement = profile.placement else { return nil }
        switch placement.kind {
        case .bridge:
            let bridge = placement.bridge?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return bridge.isEmpty ? nil : bridge
        case .local, .unknown:
            return nil
        }
    }

    private func connect(profile: HermesSetupProfile?) {
        connectTask?.cancel()
        connecting = true
        connectTask = Task { @MainActor in
            defer {
                if !Task.isCancelled {
                    connecting = false
                    connectTask = nil
                }
            }
            let result = await session.connectHermes(
                profile: profile?.placement == nil || profile?.placement?.kind == .local ? profile?.profile : nil,
                placement: profile?.placement
            )
            guard !Task.isCancelled else { return }
            guard let result else {
                await loadStatus()
                return
            }
            guard !Task.isCancelled,
                  let chat = session.hermesChat(forBotID: result.botId) else {
                return
            }
            if let onOpenChat {
                onOpenChat(chat)
            } else {
                dismiss()
            }
        }
    }

    private func loadStatus() async {
        guard !Task.isCancelled else { return }
        loading = true
        let next = await session.hermesSetupStatus()
        guard !Task.isCancelled else { return }
        status = next
        loading = false
    }

    private var iconName: String {
        switch presentation.state {
        case .checking: return "hourglass"
        case .ready: return "link"
        case .connected: return "checkmark.circle"
        case .needsSetup: return "arrow.down.circle"
        case .unavailable: return "exclamationmark.triangle"
        }
    }

    private var iconColor: Color {
        switch presentation.state {
        case .checking: return .secondary
        case .ready: return .mint
        case .connected: return .green
        case .needsSetup: return .orange
        case .unavailable: return .orange
        }
    }
}
