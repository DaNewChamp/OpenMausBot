import Foundation

/// Collapses advertised Claude model duplicates into one row per family with
/// an optional 1M-context toggle when both counterparts exist.
public struct CompactClaudeModelRow: Hashable, Sendable, Identifiable {
    public var id: String { standardModelId }
    public var label: String
    public var standardModelId: String
    public var oneMModelId: String?
    public var instanceId: String

    public var showsOneMToggle: Bool { oneMModelId != nil }

    public init(label: String, standardModelId: String, oneMModelId: String?, instanceId: String) {
        self.label = label
        self.standardModelId = standardModelId
        self.oneMModelId = oneMModelId
        self.instanceId = instanceId
    }

    public func selectedModelId(forOneMEnabled enabled: Bool) -> String {
        if enabled, let oneMModelId { return oneMModelId }
        return standardModelId
    }

    public func oneMEnabled(for selectedModelId: String) -> Bool {
        guard let oneMModelId else { return false }
        return selectedModelId == oneMModelId
    }
}

public enum ClaudeModelFamilyPolicy: Sendable {
    private static let oneMSuffixes = ["-1m", "-thinking-high", "-thinking-medium", "-thinking-low", "-thinking"]

    public static func compactRows(
        from models: [MobileCatalogModel],
        preservingSelection selectionId: String? = nil
    ) -> [CompactClaudeModelRow] {
        var groups: [String: [MobileCatalogModel]] = [:]
        for model in models {
            let key = familyKey(for: model.id)
            groups[key, default: []].append(model)
        }

        var rows: [CompactClaudeModelRow] = groups.values.compactMap { group in
            guard let standard = pickStandard(in: group) else { return nil }
            let oneM = pickOneM(in: group, standardId: standard.id)
            return CompactClaudeModelRow(
                label: displayLabel(for: standard),
                standardModelId: standard.id,
                oneMModelId: oneM?.id,
                instanceId: standard.instanceId
            )
        }
        .sorted {
            if $0.label != $1.label { return $0.label < $1.label }
            return $0.standardModelId < $1.standardModelId
        }

        if let selectionId,
           !rows.contains(where: { $0.standardModelId == selectionId || $0.oneMModelId == selectionId }) {
            let orphan = models.first { $0.id == selectionId }
            rows.append(
                CompactClaudeModelRow(
                    label: orphan.map { displayLabel(for: $0) }
                        ?? AdvertisedModelCatalog.displayModelLabel(selectionId),
                    standardModelId: selectionId,
                    oneMModelId: nil,
                    instanceId: orphan?.instanceId ?? models.first?.instanceId ?? "claude"
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
            ModelOption(id: $0.standardModelId, label: $0.label, instanceId: $0.instanceId)
        }
    }

    private static func familyKey(for modelId: String) -> String {
        var key = ProviderCatalogPolicy.isClaudeModelId(modelId) ? modelBase(modelId) : modelId
        for suffix in oneMSuffixes.sorted(by: { $0.count > $1.count }) {
            if key.hasSuffix(suffix) {
                key = String(key.dropLast(suffix.count))
                break
            }
        }
        return key
    }

    private static func modelBase(_ modelId: String) -> String {
        let normalized = modelId.lowercased()
        return String(normalized.split(separator: "[", maxSplits: 1, omittingEmptySubsequences: false).first ?? Substring(normalized))
    }

    private static func isOneMVariant(_ modelId: String) -> Bool {
        let lower = modelBase(modelId)
        if lower.hasSuffix("-1m") { return true }
        for suffix in oneMSuffixes where suffix != "-1m" {
            if lower.hasSuffix(suffix) { return true }
        }
        return false
    }

    private static func pickStandard(in group: [MobileCatalogModel]) -> MobileCatalogModel? {
        group.first { !isOneMVariant($0.id) }
            ?? group.min(by: { $0.id.count < $1.id.count })
    }

    private static func pickOneM(in group: [MobileCatalogModel], standardId: String) -> MobileCatalogModel? {
        group.first { $0.id != standardId && isOneMVariant($0.id) }
    }

    private static func displayLabel(for model: MobileCatalogModel) -> String {
        let trimmed = model.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
                .replacingOccurrences(of: " 1M Thinking", with: "")
                .replacingOccurrences(of: " (Thinking)", with: "")
                .replacingOccurrences(of: " 1M", with: "")
        }
        return AdvertisedModelCatalog.displayModelLabel(model.id)
    }
}
