import Foundation

/// Claude-facing family rows built on `ModelFamilyPolicy`. Thinking is an
/// independent axis; it is never treated as a 1M counterpart.
public struct CompactClaudeModelRow: Hashable, Sendable, Identifiable {
    public var familyKey: String
    public var label: String
    public var instanceId: String
    public var variants: [ModelAdvertisedVariant]
    public var showsOneMToggle: Bool
    public var showsThinkingToggle: Bool

    public var id: String { familyKey }
    public var rawModelIds: [String] { variants.map(\.modelId) }

    public init(
        familyKey: String,
        label: String,
        instanceId: String,
        variants: [ModelAdvertisedVariant],
        showsOneMToggle: Bool,
        showsThinkingToggle: Bool
    ) {
        self.familyKey = familyKey
        self.label = label
        self.instanceId = instanceId
        self.variants = variants
        self.showsOneMToggle = showsOneMToggle
        self.showsThinkingToggle = showsThinkingToggle
    }

    public func selectedModelId(
        oneMEnabled: Bool,
        thinking: Bool,
        fast: Bool,
        effort: String?
    ) -> String? {
        let family = ModelFamily(
            key: familyKey,
            providerId: "claude",
            label: label,
            sources: [
                ModelFamilySource(
                    instanceId: instanceId,
                    displayName: instanceId,
                    available: true,
                    unavailableReason: nil,
                    variants: variants,
                    capabilityEffortLevels: [],
                    effortEncodedInModelId: variants.contains { $0.axes.effort != nil }
                )
            ],
            privacyNotices: variants.compactMap(\.privacyNotice)
        )
        return ModelFamilyPolicy.resolveVariant(
            in: family,
            instanceId: instanceId,
            effort: effort,
            thinking: thinking,
            fast: fast,
            oneM: oneMEnabled
        )?.modelId
    }
}

public enum ClaudeModelFamilyPolicy: Sendable {
    public static func compactRows(
        from models: [MobileCatalogModel],
        preservingSelection selectionId: String? = nil
    ) -> [CompactClaudeModelRow] {
        let byInstance = Dictionary(grouping: models, by: \.instanceId)
        let instances = byInstance.map { instanceId, rows in
            Instance(
                instanceId: instanceId,
                driverKind: "claudeAgent",
                displayName: "Claude",
                snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
                models: ModelCatalog(
                    default: rows.first?.id ?? "",
                    options: rows.map { ModelOption(id: $0.id, label: $0.label, instanceId: $0.instanceId) }
                )
            )
        }
        let seed = selectionId ?? models.first?.id ?? ""
        let catalog = ModelFamilyPolicy.catalog(
            from: instances,
            selection: ModelSelection(instanceId: models.first?.instanceId ?? "claude", model: seed)
        )
        var rows = catalog.families
            .filter { $0.providerId == "claude" || $0.key.hasPrefix("claude") }
            .map { family -> CompactClaudeModelRow in
                let source = family.sources.first
                let variants = source?.variants ?? []
                return CompactClaudeModelRow(
                    familyKey: family.key,
                    label: family.label,
                    instanceId: source?.instanceId ?? models.first?.instanceId ?? "claude",
                    variants: variants,
                    showsOneMToggle: ModelFamilyPolicy.contextClaim(for: variants) == .toggle,
                    showsThinkingToggle: ModelFamilyPolicy.thinkingIsIndependent(in: variants)
                )
            }
            .sorted {
                if $0.label != $1.label { return $0.label < $1.label }
                return $0.familyKey < $1.familyKey
            }

        if let selectionId,
           !rows.contains(where: { $0.rawModelIds.contains(selectionId) || $0.familyKey == ModelFamilyPolicy.parse(selectionId).familyKey }) {
            let orphan = models.first { $0.id == selectionId }
            rows.append(
                CompactClaudeModelRow(
                    familyKey: ModelFamilyPolicy.parse(selectionId).familyKey,
                    label: orphan.map { cleaned($0.label, fallback: $0.id) }
                        ?? AdvertisedModelCatalog.displayModelLabel(selectionId),
                    instanceId: orphan?.instanceId ?? models.first?.instanceId ?? "claude",
                    variants: orphan.map {
                        [
                            ModelAdvertisedVariant(
                                instanceId: $0.instanceId,
                                modelId: $0.id,
                                label: $0.label,
                                axes: ModelFamilyPolicy.parse($0.id).axes,
                                privacyNotice: ModelFamilyPolicy.privacyNotice(from: $0.label)
                            )
                        ]
                    } ?? [
                        ModelAdvertisedVariant(
                            instanceId: models.first?.instanceId ?? "claude",
                            modelId: selectionId,
                            label: AdvertisedModelCatalog.displayModelLabel(selectionId),
                            axes: ModelFamilyPolicy.parse(selectionId).axes,
                            privacyNotice: nil
                        )
                    ],
                    showsOneMToggle: false,
                    showsThinkingToggle: false
                )
            )
        }
        return rows
    }

    public static func compactModelOptions(
        from models: [ModelOption],
        instanceId: String,
        preservingSelection selectionId: String? = nil
    ) -> [ModelOption] {
        let mobile = models.map {
            MobileCatalogModel(id: $0.id, label: $0.label, instanceId: $0.instanceId ?? instanceId, isDefault: false)
        }
        return compactRows(from: mobile, preservingSelection: selectionId).map {
            ModelOption(id: $0.familyKey, label: $0.label, instanceId: $0.instanceId)
        }
    }

    private static func cleaned(_ label: String, fallback: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return AdvertisedModelCatalog.displayModelLabel(fallback) }
        return ModelFamilyPolicy.familyLabel(from: [
            ModelAdvertisedVariant(
                instanceId: "",
                modelId: fallback,
                label: trimmed,
                axes: ModelFamilyPolicy.parse(fallback).axes,
                privacyNotice: ModelFamilyPolicy.privacyNotice(from: trimmed)
            )
        ])
    }
}
