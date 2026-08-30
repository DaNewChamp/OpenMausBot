import CompanionCore
import SwiftUI

/// Placeholder layout while engine/model catalogs load from the harness.
struct ModelPickerLoadingView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(0..<5, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 999, style: .continuous)
                            .fill(Color.primary.opacity(0.07))
                            .frame(width: 92, height: 34)
                    }
                }
                .padding(.horizontal, 2)
            }

            VStack(spacing: 0) {
                ForEach(0..<4, id: \.self) { index in
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Color.primary.opacity(0.08))
                            .frame(width: CGFloat(120 + index * 14), height: 14)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44, alignment: .leading)

                    if index < 3 {
                        Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                    }
                }
            }
            .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading models")
    }
}

struct ModelPickerErrorView: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Try again", action: retry)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct ModelPickerEmptyView: View {
    var body: some View {
        Label(ModelSelectionPolicy.emptyCatalogExplanation, systemImage: "cpu")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityLabel(ModelSelectionPolicy.emptyCatalogExplanation)
    }
}

/// Horizontal reasoning chips for model sheets and profiles.
struct ModelEffortPicker: View {
    let levels: [String]
    @Binding var selection: String?
    var disabled: Bool = false
    var onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reasoning")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    EffortChip(
                        title: "Default",
                        selected: selection == nil,
                        disabled: disabled
                    ) {
                        selection = nil
                        onChange()
                    }

                    ForEach(levels, id: \.self) { level in
                        EffortChip(
                            title: ModelEffortPicker.effortLabel(level),
                            selected: selection == level,
                            disabled: disabled
                        ) {
                            selection = level
                            onChange()
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    static func effortLabel(_ level: String) -> String {
        switch level {
        case "xhigh": return "X-High"
        default: return level.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }
}

private struct EffortChip: View {
    let title: String
    let selected: Bool
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .padding(.horizontal, 12)
                .frame(minHeight: VBotSurface.Hit.minimum)
                .background(
                    selected ? ModelPickerStyle.chipSelected : ModelPickerStyle.chip,
                    in: Capsule()
                )
                .overlay {
                    Capsule()
                        .strokeBorder(selected ? Color.primary.opacity(0.12) : .clear, lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Premium model picker for bot profiles and settings. Mirrors the desktop
/// `ModelPicker` rail + list pattern with V Bot solid surfaces.
struct ModelPickerView: View {
    let instances: [Instance]
    @Binding var selectedInstanceId: String
    @Binding var selectedModelId: String
    var disabled: Bool = false
    var modelsDisabled: Bool = false
    var footerHint: String?
    var onSelectionChange: () -> Void

    @State private var railInstanceId: String?

    private var railInstances: [Instance] {
        ProviderCatalogPolicy.groupedInstances(
            advertised: instances,
            selection: ModelSelection(instanceId: selectedInstanceId, model: selectedModelId)
        )
    }

    private var activeRailId: String {
        if let railInstanceId { return railInstanceId }
        return ProviderCatalogPolicy.resolvedRail(
            advertised: instances,
            selection: currentSelection,
            activeRailId: nil
        )?.instanceId ?? selectedInstanceId
    }

    private var currentSelection: ModelSelection {
        ModelSelection(instanceId: selectedInstanceId, model: selectedModelId)
    }

    private var railInstance: Instance? {
        ProviderCatalogPolicy.resolvedRail(
            advertised: instances,
            selection: currentSelection,
            activeRailId: activeRailId
        )
    }

    private var models: [ModelOption] {
        railInstance?.models.options ?? []
    }

    private var rowsDisabled: Bool {
        disabled || modelsDisabled || ProviderCatalogPolicy.modelsDisabled(
            advertised: instances,
            selection: currentSelection,
            activeRailId: activeRailId,
            hostWideEngine: false
        )
    }

    private func optionIsSelected(_ option: ModelOption, rail: Instance) -> Bool {
        (option.instanceId ?? rail.instanceId) == selectedInstanceId && selectedModelId == option.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if ProviderCatalogPolicy.isEmpty(advertised: instances, selection: currentSelection) {
                ModelPickerEmptyView()
            } else {
                engineRail
                modelList
            }

            if let footerHint {
                Text(footerHint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var engineRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(railInstances) { instance in
                    EngineChip(
                        instance: instance,
                        selected: instance.instanceId == activeRailId,
                        selectedInstanceId: selectedInstanceId,
                        selectedModelId: selectedModelId,
                        disabled: disabled || (!instance.allowsInstanceChange && instance.instanceId != activeRailId),
                        unavailable: !instance.snapshot.isAvailable || !instance.allowsInstanceChange
                    ) {
                        guard let next = ProviderCatalogPolicy.selectionAfterProviderTap(
                            current: currentSelection,
                            tapped: instance,
                            advertised: instances
                        ) else { return }
                        railInstanceId = instance.instanceId
                        if next.instanceId != selectedInstanceId || next.model != selectedModelId {
                            selectedInstanceId = next.instanceId
                            selectedModelId = next.model
                            onSelectionChange()
                        }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    @ViewBuilder
    private var modelList: some View {
        if let railInstance {
            VStack(alignment: .leading, spacing: 8) {
                if !railInstance.snapshot.isAvailable, let reason = railInstance.snapshot.reason {
                    Label(reason, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 2)
                }

                VStack(spacing: 0) {
                    if models.isEmpty {
                        Text(ModelSelectionPolicy.engineEmptyExplanation)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                    } else {
                        ForEach(Array(models.enumerated()), id: \.element.id) { index, option in
                            ModelRow(
                                label: option.label,
                                selected: optionIsSelected(option, rail: railInstance),
                                isDefault: option.id == railInstance.models.default,
                                disabled: rowsDisabled
                            ) {
                                guard let next = ProviderCatalogPolicy.selectionAfterModelTap(
                                    current: currentSelection,
                                    rail: railInstance,
                                    modelId: option.id
                                ) else { return }
                                selectedInstanceId = next.instanceId
                                selectedModelId = next.model
                                onSelectionChange()
                            }

                            if index < models.count - 1 {
                                Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                            }
                        }

                        if models.contains(where: { optionIsSelected($0, rail: railInstance) }) == false,
                           ProviderCatalogPolicy.shouldDisplaySelection(
                            currentSelection,
                            advertised: instances
                           ),
                           ProviderCatalogPolicy.resolvedRail(
                            advertised: instances,
                            selection: currentSelection,
                            activeRailId: railInstance.instanceId
                           )?.instanceId == railInstance.instanceId {
                            Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                            ModelRow(
                                label: AdvertisedModelCatalog.displayModelLabel(selectedModelId),
                                selected: true,
                                isDefault: false,
                                disabled: rowsDisabled
                            ) {
                                guard ProviderCatalogPolicy.selectionAfterModelTap(
                                    current: currentSelection,
                                    rail: railInstance,
                                    modelId: selectedModelId
                                ) != nil else { return }
                                onSelectionChange()
                            }
                        }
                    }
                }
                .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }
}

private struct EngineChip: View {
    let instance: Instance
    let selected: Bool
    var selectedInstanceId: String = ""
    var selectedModelId: String = ""
    var disabled: Bool = false
    var unavailable: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ProviderMarks.mark(for: instance.markKey, size: 20)
                Text(instance.pickerTitle)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 72)
            .padding(.vertical, 10)
            .background(
                selected ? ModelPickerStyle.chipSelected : ModelPickerStyle.chip,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(selected ? Color.primary.opacity(0.14) : .clear, lineWidth: 1)
            }
            .opacity(disabled ? 0.55 : unavailable ? 0.72 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(instance.pickerTitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct ModelRow: View {
    let label: String
    let selected: Bool
    let isDefault: Bool
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(label)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if isDefault {
                    Text("Default")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(ModelPickerStyle.chip, in: Capsule())
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .background(selected ? ModelPickerStyle.rowSelected : Color.clear)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private enum ModelPickerStyle {
    static let divider = Color.primary.opacity(0.08)
    static let chip = VBotSurface.controlSurface
    static let chipSelected = VBotSurface.composerSurface
    static let listSurface = VBotSurface.controlSurface.opacity(0.72)
    static let rowSelected = Color.primary.opacity(0.05)
}

/// Compact summary row for profile surfaces — tap to expand the full picker.
struct ModelSelectionSummaryRow: View {
    let instanceTitle: String
    let modelTitle: String
    let providerKey: String
    var subtitle: String?
    var disabled: Bool = false

    var body: some View {
        HStack(spacing: 14) {
            ProviderMarks.mark(for: providerKey, size: 22)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(instanceTitle)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(modelTitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 62)
        .contentShape(Rectangle())
        .opacity(disabled ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(instanceTitle), \(modelTitle)")
    }
}

/// Shared catalog surface for chat, profile, and settings pickers.
struct ModelPickerCatalogHost: View {
    let instances: [Instance]
    let loading: Bool
    let error: String?
    let canEdit: Bool
    let working: Bool
    let saving: Bool
    @Binding var selectedInstanceId: String
    @Binding var selectedModelId: String
    var effortLevels: [String] = []
    @Binding var selectedEffort: String?
    var showsEffort: Bool = false
    var hostWide: Bool = false
    var onRetry: () -> Void
    var onSelectionChange: () -> Void

    private var currentSelection: ModelSelection {
        ModelSelection(instanceId: selectedInstanceId, model: selectedModelId)
    }

    private var presentation: ModelCatalogPresentation {
        ModelCatalogPresentation.surface(
            loading: loading,
            error: error,
            instances: instances,
            canEdit: canEdit,
            selection: currentSelection
        )
    }

    private var switchBlocked: Bool {
        presentation.selectionDisabled
            || !ModelSelectionPolicy.allowsSwitch(working: working, saving: saving, catalogLoading: loading)
    }

    private var footer: String {
        ModelSelectionPolicy.footerHint(working: working, canEdit: canEdit, hostWide: hostWide)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch presentation {
            case .loading:
                ModelPickerLoadingView()
                    .frame(maxWidth: .infinity, alignment: .leading)
            case let .error(message):
                ModelPickerErrorView(message: message, retry: onRetry)
            case .empty:
                ModelPickerEmptyView()
            case let .catalog(_, refreshError, refreshing):
                if let refreshError {
                    ModelPickerErrorView(message: refreshError, retry: onRetry)
                } else if refreshing {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text(ModelSelectionPolicy.refreshingExplanation)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(ModelSelectionPolicy.refreshingExplanation)
                }
                ModelPickerView(
                    instances: instances,
                    selectedInstanceId: $selectedInstanceId,
                    selectedModelId: $selectedModelId,
                    disabled: switchBlocked,
                    modelsDisabled: ProviderCatalogPolicy.modelsDisabled(
                        advertised: instances,
                        selection: currentSelection,
                        activeRailId: selectedInstanceId,
                        hostWideEngine: hostWide
                    ) || presentation.selectionDisabled,
                    footerHint: footer
                ) {
                    onSelectionChange()
                }

                if canEdit, !loading {
                    Button(ModelSelectionPolicy.refreshModels) {
                        onRetry()
                    }
                    .font(.footnote.weight(.medium))
                    .disabled(presentation.selectionDisabled && !presentation.isRefreshing)
                }

                if showsEffort {
                    ModelEffortPicker(
                        levels: effortLevels,
                        selection: $selectedEffort,
                        disabled: switchBlocked
                    ) {
                        onSelectionChange()
                    }
                }

                if saving {
                    Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Host-wide reconstructed provider picker. Uses advertised `selectable` /
/// `modelSelectable` flags instead of a vendor name.
struct ReconstructedProviderPicker: View {
    let providers: [VBotProvider]
    let selectedProvider: String
    let selectedModelId: String
    var models: [VBotProviderModel]
    var disabled: Bool = false
    var onProviderChange: (String) -> Void
    var onModelChange: (String) -> Void

    private var selected: VBotProvider? {
        providers.first { $0.id == selectedProvider }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(providers) { provider in
                        Button {
                            guard !disabled, provider.selectable else { return }
                            onProviderChange(provider.id)
                        } label: {
                            VStack(spacing: 6) {
                                ProviderMarks.mark(for: provider.id, size: 20)
                                Text(provider.label)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(selectedProvider == provider.id ? Color.primary : .secondary)
                                    .lineLimit(1)
                            }
                            .frame(width: 72)
                            .padding(.vertical, 10)
                            .background(
                                selectedProvider == provider.id
                                    ? ModelPickerStyle.chipSelected
                                    : ModelPickerStyle.chip,
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                            )
                            .opacity(provider.selectable ? 1 : 0.55)
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled || !provider.selectable)
                    }
                }
            }

            if let selected, selected.modelSelectable, !models.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(models.enumerated()), id: \.element.id) { index, model in
                        ModelRow(
                            label: AdvertisedModelCatalog.displayModelLabel(model.id),
                            selected: model.id == selectedModelId,
                            isDefault: model.current,
                            disabled: disabled
                        ) {
                            onModelChange(model.id)
                        }
                        if index < models.count - 1 {
                            Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                        }
                    }
                }
                .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else if selected?.modelSelectable == false {
                Label(ModelSelectionPolicy.providerKeepsLocalModel, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

#if DEBUG
/// Debug-only screenshot host. Launch with `-open-provider-settings`.
struct ProviderSettingsPreviewHost: View {
    @State private var instanceId = "cursor"
    @State private var modelId = "auto"
    @State private var effort: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                ModelPickerCatalogHost(
                    instances: Session.storePreviewProviderCatalog(),
                    loading: false,
                    error: nil,
                    canEdit: true,
                    working: false,
                    saving: false,
                    selectedInstanceId: $instanceId,
                    selectedModelId: $modelId,
                    selectedEffort: $effort,
                    onRetry: {},
                    onSelectionChange: {}
                )
                .padding(.horizontal, VBotSurface.Space.page)
                .padding(.top, VBotSurface.Space.section)
                .padding(.bottom, VBotSurface.Space.section)
            }
            .navigationTitle("Bot Settings")
            .navigationBarTitleDisplayMode(.inline)
            .vbotCanvas()
        }
    }
}

private enum ModelPickerPreviewData {
    static let instances: [Instance] = {
        let json = """
        [
          {
            "instanceId":"claude","driverKind":"claudeAgent","displayName":"Claude",
            "snapshot":{"state":"available"},
            "models":{"default":"claude-sonnet-5","options":[
              {"id":"claude-sonnet-5","label":"Claude Sonnet 5"},
              {"id":"claude-haiku-4-5","label":"Claude Haiku 4.5"}
            ]}
          },
          {
            "instanceId":"codex","driverKind":"codex","displayName":"Codex",
            "snapshot":{"state":"available"},
            "models":{"default":"gpt-5.6-sol","options":[
              {"id":"gpt-5.6-sol","label":"GPT 5.6 Sol"}
            ]}
          },
          {
            "instanceId":"cursor","driverKind":"cursorAgent","displayName":"Cursor",
            "snapshot":{"state":"available"},
            "models":{"default":"auto","options":[
              {"id":"auto","label":"Auto"},
              {"id":"composer-2.5","label":"Composer 2.5"}
            ]}
          }
        ]
        """
        return (try? JSONDecoder().decode([Instance].self, from: Data(json.utf8))) ?? []
    }()
}

#Preview("Catalog loading") {
    ModelPickerLoadingView()
        .padding()
        .vbotCanvas()
}

#Preview("Catalog error") {
    ModelPickerErrorView(message: "Could not load models from this computer.") {}
        .padding()
        .vbotCanvas()
}

#Preview("Catalog empty") {
    ModelPickerEmptyView()
        .padding()
        .vbotCanvas()
}

#Preview("Catalog ready") {
    ModelPickerView(
        instances: ModelPickerPreviewData.instances,
        selectedInstanceId: .constant("claude"),
        selectedModelId: .constant("claude-sonnet-5"),
        footerHint: ModelSelectionPolicy.idleHint
    ) {}
    .padding()
    .vbotCanvas()
}

#Preview("Catalog busy") {
    ModelPickerView(
        instances: ModelPickerPreviewData.instances,
        selectedInstanceId: .constant("claude"),
        selectedModelId: .constant("claude-sonnet-5"),
        disabled: true,
        footerHint: ModelSelectionPolicy.busyExplanation
    ) {}
    .padding()
    .vbotCanvas()
}

#Preview("Catalog offline cached") {
    ModelPickerView(
        instances: ModelPickerPreviewData.instances,
        selectedInstanceId: .constant("claude"),
        selectedModelId: .constant("claude-sonnet-5"),
        disabled: true,
        modelsDisabled: true,
        footerHint: CalmSurfacePolicy.reconnectToEdit
    ) {}
    .padding()
    .vbotCanvas()
}
#endif
