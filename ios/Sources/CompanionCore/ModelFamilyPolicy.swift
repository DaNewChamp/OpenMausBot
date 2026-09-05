import Foundation

/// Axes that Cursor-style catalog IDs encode as suffixes. Resolution always
/// looks up an advertised `(instanceId, modelId)` tuple — never concatenates.
public struct ModelVariantAxes: Equatable, Hashable, Sendable {
    public var effort: String?
    public var thinking: Bool
    public var fast: Bool
    public var explicitOneM: Bool

    public init(effort: String? = nil, thinking: Bool = false, fast: Bool = false, explicitOneM: Bool = false) {
        self.effort = effort
        self.thinking = thinking
        self.fast = fast
        self.explicitOneM = explicitOneM
    }
}

public struct ParsedModelId: Equatable, Sendable {
    public var familyKey: String
    public var axes: ModelVariantAxes

    public init(familyKey: String, axes: ModelVariantAxes) {
        self.familyKey = familyKey
        self.axes = axes
    }
}

public enum ModelContextClaim: Equatable, Sendable {
    /// Both `-1m` and non-`-1m` IDs are advertised for this source.
    case toggle
    /// Every advertised variant explicitly identifies 1M in its ID or label.
    case included
    /// Unknown or mixed label-only context. Never infer standard context from an omitted label.
    case none
}

public struct ModelAdvertisedVariant: Equatable, Hashable, Sendable, Identifiable {
    public var instanceId: String
    public var modelId: String
    public var label: String
    public var axes: ModelVariantAxes
    public var privacyNotice: String?

    public var id: String {
        ModelFamilyPolicy.compositeId(instanceId: instanceId, modelId: modelId)
    }

    public init(
        instanceId: String,
        modelId: String,
        label: String,
        axes: ModelVariantAxes,
        privacyNotice: String?
    ) {
        self.instanceId = instanceId
        self.modelId = modelId
        self.label = label
        self.axes = axes
        self.privacyNotice = privacyNotice
    }
}

public struct ModelFamilySource: Equatable, Sendable, Identifiable {
    public var instanceId: String
    public var displayName: String
    public var available: Bool
    public var unavailableReason: String?
    public var variants: [ModelAdvertisedVariant]
    public var capabilityEffortLevels: [String]
    public var effortEncodedInModelId: Bool

    public var id: String { instanceId }

    public init(
        instanceId: String,
        displayName: String,
        available: Bool,
        unavailableReason: String?,
        variants: [ModelAdvertisedVariant],
        capabilityEffortLevels: [String],
        effortEncodedInModelId: Bool
    ) {
        self.instanceId = instanceId
        self.displayName = displayName
        self.available = available
        self.unavailableReason = unavailableReason
        self.variants = variants
        self.capabilityEffortLevels = capabilityEffortLevels
        self.effortEncodedInModelId = effortEncodedInModelId
    }
}

public struct ModelFamily: Equatable, Sendable, Identifiable {
    public var key: String
    public var providerId: String
    public var label: String
    public var sources: [ModelFamilySource]
    public var privacyNotices: [String]

    public var id: String {
        ModelFamilyPolicy.compositeId(instanceId: providerId, modelId: key)
    }

    public init(
        key: String,
        providerId: String,
        label: String,
        sources: [ModelFamilySource],
        privacyNotices: [String]
    ) {
        self.key = key
        self.providerId = providerId
        self.label = label
        self.sources = sources
        self.privacyNotices = privacyNotices
    }
}

public struct ModelFamilyCatalog: Equatable, Sendable {
    public var families: [ModelFamily]
    public var current: ModelSelection
    public var currentIsAdvertised: Bool
    public var currentUnavailableLabel: String?

    public init(
        families: [ModelFamily],
        current: ModelSelection,
        currentIsAdvertised: Bool,
        currentUnavailableLabel: String?
    ) {
        self.families = families
        self.current = current
        self.currentIsAdvertised = currentIsAdvertised
        self.currentUnavailableLabel = currentUnavailableLabel
    }
}

#if DEBUG
public enum ModelCatalogDebugHook {
    /// Simulator QA can assign captured instances without touching server state.
    public static var previewInstances: [Instance]?
}
#endif

/// Groups advertised catalog rows into genuine model families and resolves
/// variants by exact source tuple.
public enum ModelFamilyPolicy: Sendable {
    private static let effortTokens: Set<String> = [
        "none", "low", "medium", "high", "xhigh", "max",
    ]

    public static func compositeId(instanceId: String, modelId: String) -> String {
        "\(instanceId)\u{1F}\(modelId)"
    }

    public static func parse(_ modelId: String) -> ParsedModelId {
        let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ParsedModelId(familyKey: trimmed, axes: ModelVariantAxes())
        }
        let lower = trimmed.lowercased()
        guard ["gpt-", "claude-", "composer-"].contains(where: lower.hasPrefix), !trimmed.contains("/") else {
            return ParsedModelId(familyKey: trimmed, axes: ModelVariantAxes())
        }
        var tokens = trimmed.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        var effort: String?
        var thinking = false
        var fast = false
        var explicitOneM = false

        while tokens.count > 1 {
            let last = tokens[tokens.count - 1].lowercased()
            if last == "fast", !fast {
                fast = true
                tokens.removeLast()
                continue
            }
            if last == "1m", !explicitOneM {
                explicitOneM = true
                tokens.removeLast()
                continue
            }
            if last == "thinking", !thinking {
                thinking = true
                tokens.removeLast()
                continue
            }
            if effort == nil, last == "high", tokens.count > 2, tokens[tokens.count - 2].lowercased() == "extra" {
                effort = "extra-high"
                tokens.removeLast(2)
                continue
            }
            if effort == nil, effortTokens.contains(last) {
                effort = last
                tokens.removeLast()
                continue
            }
            break
        }

        let familyKey = tokens.joined(separator: "-")
        return ParsedModelId(
            familyKey: familyKey.isEmpty ? trimmed : familyKey,
            axes: ModelVariantAxes(effort: effort, thinking: thinking, fast: fast, explicitOneM: explicitOneM)
        )
    }

    public static func privacyNotice(from label: String) -> String? {
        guard let start = label.firstIndex(of: "("),
              let end = label[start...].firstIndex(of: ")"),
              start < end
        else { return nil }
        let inner = label[label.index(after: start)..<end]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !inner.isEmpty else { return nil }
        let upper = inner.uppercased()
        if upper.contains("ZDR") || upper.contains("PRIVACY") {
            return inner
        }
        return nil
    }

    public static func contextClaim(for variants: [ModelAdvertisedVariant]) -> ModelContextClaim {
        let flags = variants.map(\.axes.explicitOneM)
        guard !flags.isEmpty else { return .none }
        if flags.contains(true), flags.contains(false) { return .toggle }
        if variants.allSatisfy({ variant in
            variant.axes.explicitOneM || variant.label.range(of: #"\b1M\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        }) { return .included }
        return .none
    }

    public static func thinkingIsIndependent(in variants: [ModelAdvertisedVariant]) -> Bool {
        let flags = variants.map(\.axes.thinking)
        return flags.contains(true) && flags.contains(false)
    }

    public static func catalog(from instances: [Instance], selection: ModelSelection) -> ModelFamilyCatalog {
        var buckets: [String: [String: [ModelAdvertisedVariant]]] = [:]
        var sourceMeta: [String: (displayName: String, available: Bool, reason: String?, effort: [String])] = [:]
        var advertised = Set<String>()

        for instance in instances {
            sourceMeta[instance.instanceId] = (
                instance.pickerTitle,
                instance.snapshot.isAvailable,
                instance.snapshot.reason,
                instance.capabilities?.effortLevels ?? []
            )
            for option in instance.models.options {
                let providerId = ProviderCatalogPolicy.classifyProvider(
                    instanceId: instance.instanceId,
                    driverKind: instance.driverKind,
                    modelId: option.id
                )
                let parsed = parse(option.id)
                let variant = ModelAdvertisedVariant(
                    instanceId: instance.instanceId,
                    modelId: option.id,
                    label: option.label,
                    axes: parsed.axes,
                    privacyNotice: privacyNotice(from: option.label)
                )
                buckets[providerId, default: [:]][parsed.familyKey, default: []].append(variant)
                advertised.insert(compositeId(instanceId: instance.instanceId, modelId: option.id))
            }
        }

        var families: [ModelFamily] = []
        for (providerId, byKey) in buckets {
            for (key, variants) in byKey {
                let bySource = Dictionary(grouping: variants, by: \.instanceId)
                let sources = bySource.keys.sorted().map { instanceId -> ModelFamilySource in
                    let rows = bySource[instanceId] ?? []
                    let meta = sourceMeta[instanceId]
                    return ModelFamilySource(
                        instanceId: instanceId,
                        displayName: meta?.displayName ?? instanceId,
                        available: meta?.available ?? false,
                        unavailableReason: meta?.available == true ? nil : meta?.reason,
                        variants: rows,
                        capabilityEffortLevels: meta?.effort ?? [],
                        effortEncodedInModelId: rows.contains { $0.axes.effort != nil }
                    )
                }
                let notices = orderedUnique(variants.compactMap(\.privacyNotice))
                families.append(
                    ModelFamily(
                        key: key,
                        providerId: providerId,
                        label: familyLabel(from: variants),
                        sources: sources,
                        privacyNotices: notices
                    )
                )
            }
        }
        families.sort {
            if $0.providerId != $1.providerId { return $0.providerId < $1.providerId }
            if $0.label != $1.label { return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
            return $0.key < $1.key
        }

        let currentId = compositeId(instanceId: selection.instanceId, modelId: selection.model)
        let advertisedCurrent = advertised.contains(currentId)
        return ModelFamilyCatalog(
            families: families,
            current: selection,
            currentIsAdvertised: advertisedCurrent,
            currentUnavailableLabel: advertisedCurrent ? nil : ModelSelectionPolicy.currentModelUnavailable
        )
    }

    public static func featuredFamilies(
        _ families: [ModelFamily],
        selection: ModelSelection,
        limit: Int = 6
    ) -> [ModelFamily] {
        guard limit > 0 else { return [] }
        let currentKey = parse(selection.model).familyKey
        var picked: [ModelFamily] = []
        var seen = Set<String>()

        func append(_ family: ModelFamily?) {
            guard let family, seen.insert(family.id).inserted else { return }
            picked.append(family)
        }

        append(families.first { $0.key == currentKey && $0.sources.contains { $0.instanceId == selection.instanceId } }
            ?? families.first { $0.key == currentKey })

        let preferredKeys = ProviderCatalogPolicy.preferredOpenAIModelOrder.map { parse($0).familyKey }
        for key in preferredKeys {
            append(families.first { $0.key == key })
            if picked.count >= limit { return Array(picked.prefix(limit)) }
        }

        // Prefer families exposed by the native Claude source over old
        // alphabetically sorted Cursor variants, without inventing models.
        for family in families where family.providerId == "claude" && family.sources.contains(where: {
            $0.instanceId == "claude" && $0.available
        }) {
            append(family)
            if picked.count >= limit { return Array(picked.prefix(limit)) }
        }
        for family in families {
            append(family)
            if picked.count >= limit { break }
        }
        return Array(picked.prefix(limit))
    }

    public static func visibleFamilies(_ families: [ModelFamily], search: String) -> [ModelFamily] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return families }
        return families.filter { family in
            if family.label.lowercased().contains(query) { return true }
            if family.key.lowercased().contains(query) { return true }
            return family.sources.contains { source in
                source.variants.contains {
                    $0.modelId.lowercased().contains(query) || $0.label.lowercased().contains(query)
                }
            }
        }
    }

    public static func preservedSource(
        currentInstanceId: String,
        familyKey: String,
        in catalog: ModelFamilyCatalog
    ) -> String? {
        let family = catalog.families.first { $0.key == familyKey && $0.sources.contains { $0.instanceId == currentInstanceId } }
        return family == nil ? nil : currentInstanceId
    }

    public static func resolveVariant(
        in family: ModelFamily,
        instanceId: String,
        effort: String?,
        thinking: Bool,
        fast: Bool,
        oneM: Bool
    ) -> ModelAdvertisedVariant? {
        guard let source = family.sources.first(where: { $0.instanceId == instanceId }) else {
            return nil
        }
        let matches = source.variants.filter { variant in
            if variant.axes.thinking != thinking { return false }
            if variant.axes.fast != fast { return false }
            if variant.axes.explicitOneM != oneM { return false }
            if source.effortEncodedInModelId {
                return variant.axes.effort == effort
            }
            return true
        }
        if matches.count == 1 { return matches[0] }
        return matches.min { $0.modelId.count < $1.modelId.count }
    }

    public static func family(for selection: ModelSelection, in catalog: ModelFamilyCatalog) -> ModelFamily? {
        let key = parse(selection.model).familyKey
        return catalog.families.first { family in
            family.key == key && family.sources.contains { $0.instanceId == selection.instanceId }
        } ?? catalog.families.first { $0.key == key }
    }

    public static func source(for selection: ModelSelection, in family: ModelFamily) -> ModelFamilySource? {
        family.sources.first { $0.instanceId == selection.instanceId }
    }

    public static func familyLabel(from variants: [ModelAdvertisedVariant]) -> String {
        let preferred = variants.min { lhs, rhs in
            let left = axisWeight(lhs.axes)
            let right = axisWeight(rhs.axes)
            if left != right { return left < right }
            return lhs.label.count < rhs.label.count
        }
        return cleanedLabel(preferred?.label ?? variants.first?.label ?? "")
    }

    private static func axisWeight(_ axes: ModelVariantAxes) -> Int {
        var weight = 0
        if axes.effort != nil { weight += 1 }
        if axes.thinking { weight += 1 }
        if axes.fast { weight += 1 }
        if axes.explicitOneM { weight += 1 }
        return weight
    }

    private static func cleanedLabel(_ label: String) -> String {
        var text = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if let notice = privacyNotice(from: text) {
            text = text.replacingOccurrences(of: "(\(notice))", with: "")
        }
        let strips = [
            " 1M Thinking",
            " (Thinking)",
            " Thinking",
            " Extra High",
            " X-High",
            " 1M",
            " Fast",
            " None",
            " Low",
            " Medium",
            " High",
            " Max",
        ]
        for token in strips {
            text = text.replacingOccurrences(of: token, with: "")
        }
        text = text.replacingOccurrences(of: #"(?i)(GPT-\d+\.\d+)-(Sol|Terra|Luna|Mini|Nano)\b"#,
            with: "$1 $2", options: .regularExpression)
        return text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func orderedUnique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for value in values where seen.insert(value).inserted {
            result.append(value)
        }
        return result
    }
}
