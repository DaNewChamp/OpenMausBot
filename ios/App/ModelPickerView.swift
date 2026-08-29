import CompanionCore
import SwiftUI

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

    private var selectableInstances: [Instance] {
        AdvertisedModelCatalog.selectableInstances(from: instances)
    }

    private var activeRailId: String {
        railInstanceId ?? selectedInstanceId
    }

    private var railInstance: Instance? {
        AdvertisedModelCatalog.instance(id: activeRailId, in: instances)
            ?? selectableInstances.first
    }

    private var models: [ModelOption] {
        railInstance?.models.options ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if selectableInstances.isEmpty {
                Label("No model providers are available.", systemImage: "cpu")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
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
                ForEach(selectableInstances) { instance in
                    EngineChip(
                        instance: instance,
                        selected: instance.instanceId == activeRailId,
                        disabled: disabled
                    ) {
                        guard !disabled else { return }
                        railInstanceId = instance.instanceId
                        if instance.instanceId != selectedInstanceId {
                            selectedInstanceId = instance.instanceId
                            selectedModelId = AdvertisedModelCatalog.alignedModel(
                                instanceId: instance.instanceId,
                                currentModel: selectedModelId,
                                in: instances
                            )
                            onSelectionChange()
                        }
                    }
                }

                if selectableInstances.contains(where: { $0.instanceId == selectedInstanceId }) == false,
                   let orphan = AdvertisedModelCatalog.instance(id: selectedInstanceId, in: instances)
                    ?? instances.first(where: { $0.instanceId == selectedInstanceId }) {
                    EngineChip(
                        instance: orphan,
                        selected: activeRailId == orphan.instanceId,
                        disabled: disabled,
                        unavailable: true
                    ) {
                        guard !disabled else { return }
                        railInstanceId = orphan.instanceId
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
                HStack(spacing: 8) {
                    ProviderMarks.mark(for: markKey(for: railInstance), size: 16)
                    Text(railInstance.pickerTitle)
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 0)
                    if railInstance.snapshot.isAvailable {
                        Text("Ready")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.green.opacity(0.12), in: Capsule())
                    } else if let reason = railInstance.snapshot.reason {
                        Text(reason)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                VStack(spacing: 0) {
                    if models.isEmpty {
                        Text("No models advertised for this engine.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                    } else {
                        ForEach(Array(models.enumerated()), id: \.element.id) { index, option in
                            ModelRow(
                                label: option.label,
                                selected: selectedInstanceId == railInstance.instanceId && selectedModelId == option.id,
                                isDefault: option.id == railInstance.models.default,
                                disabled: disabled || modelsDisabled
                            ) {
                                guard !disabled, !modelsDisabled else { return }
                                selectedInstanceId = railInstance.instanceId
                                selectedModelId = option.id
                                onSelectionChange()
                            }

                            if index < models.count - 1 {
                                Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                            }
                        }

                        if models.contains(where: { $0.id == selectedModelId }) == false,
                           selectedInstanceId == railInstance.instanceId {
                            Divider().overlay(ModelPickerStyle.divider).padding(.leading, 14)
                            ModelRow(
                                label: selectedModelId,
                                selected: true,
                                isDefault: false,
                                disabled: disabled || modelsDisabled
                            ) {
                                guard !disabled, !modelsDisabled else { return }
                                onSelectionChange()
                            }
                        }
                    }
                }
                .background(ModelPickerStyle.listSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }

    private func markKey(for instance: Instance) -> String {
        if !instance.driverKind.isEmpty { return instance.driverKind }
        return instance.instanceId
    }
}

private struct EngineChip: View {
    let instance: Instance
    let selected: Bool
    var disabled: Bool = false
    var unavailable: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ProviderMarks.mark(
                    for: instance.driverKind.isEmpty ? instance.instanceId : instance.driverKind,
                    size: 20
                )
                Text(shortTitle(instance))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 64)
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
        .accessibilityLabel(instance.pickerTitle)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func shortTitle(_ instance: Instance) -> String {
        let name = instance.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        return ProviderMarks.displayName(for: instance.driverKind.isEmpty ? instance.instanceId : instance.driverKind)
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

/// Host-wide provider picker for Grok Reconstructed settings.
struct ReconstructedProviderPicker: View {
    let providers: [VBotProvider]
    let selectedProvider: String
    let selectedModelId: String
    var models: [VBotProviderModel]
    var disabled: Bool = false
    var onProviderChange: (String) -> Void
    var onModelChange: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(providers.filter(\.selectable)) { provider in
                        Button {
                            guard !disabled else { return }
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
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled)
                    }
                }
            }

            if selectedProvider == "cursor", !models.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(models.enumerated()), id: \.element.id) { index, model in
                        ModelRow(
                            label: model.id,
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
            } else if selectedProvider != "cursor" {
                Label("Only Cursor models can be changed here.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
