import SwiftUI
import CompanionCore

/// First-party Hermes setup, intentionally separate from the reconstructed
/// engine picker. The screen only renders the safe setup projection returned
/// by the paired V Bot computer.
struct HermesSetupView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var status: HermesSetupStatus?
    @State private var loading = true
    @State private var connecting = false

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
        status?.profiles.filter { $0.botId != nil } ?? []
    }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                stateCard
                if !loading, !connecting {
                    profileContent
                }
                placementCard
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, VBotSurface.Space.section)
            .padding(.bottom, 36)
        }
        .navigationTitle("Hermes")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
        .task { await loadStatus() }
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
                    profileRow(profile, actionTitle: "Open chat")
                    if profile.id != connectedProfiles.last?.id {
                        VBotHairline().padding(.leading, 16)
                    }
                }
            }
        } else if presentation.state == .ready, !availableProfiles.isEmpty {
            VBotSurfaceGroup(
                title: HermesSetupPresentationPolicy.requiresProfileChoice(status ?? HermesSetupStatus())
                    ? "Choose a profile"
                    : nil
            ) {
                ForEach(availableProfiles) { profile in
                    profileRow(profile, actionTitle: connectLabel(for: profile))
                    if profile.id != availableProfiles.last?.id {
                        VBotHairline().padding(.leading, 16)
                    }
                }
            }
        } else if presentation.state == .ready {
            VBotSurfaceGroup {
                Text("Hermes is ready, but no profiles are available yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(16)
            }
        }
    }

    private var placementCard: some View {
        Text("Hermes connects directly on this computer. For another machine, pair that V Bot first, then connect Hermes there.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
    }

    private func profileRow(_ profile: HermesSetupProfile, actionTitle: String) -> some View {
        Button {
            connect(profile: profile)
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
        if HermesSetupPresentationPolicy.requiresProfileChoice(status) {
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

    private func connect(profile: HermesSetupProfile?) {
        connecting = true
        Task { @MainActor in
            let result = await session.connectHermes(profile: profile?.profile)
            guard !Task.isCancelled else { return }
            connecting = false
            if result != nil {
                dismiss()
            } else {
                await loadStatus()
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
