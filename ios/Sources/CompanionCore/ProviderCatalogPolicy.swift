import Foundation

/// Server-driven provider grouping for Bot Settings. Selection remains
/// `{ instanceId, model }` against the harness; tabs are providers.
public struct MobileCatalogModel: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var instanceId: String
    public var isDefault: Bool

    public init(id: String, label: String, instanceId: String, isDefault: Bool) {
        self.id = id
        self.label = label
        self.instanceId = instanceId
        self.isDefault = isDefault
    }
}

public struct MobileCatalogProvider: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var markKey: String
    public var models: [MobileCatalogModel]
}

public struct MobileProviderCatalog: Codable, Hashable, Sendable {
    public var managedBy: String
    public var providers: [MobileCatalogProvider]
}

/// Pure classification, order, label, and selection fallback for the
/// phone catalog. Mirrors `server/provider-catalog.ts`.
public enum ProviderCatalogPolicy: Sendable {
    public static let namedOrder = ["openai", "claude", "cursor", "openrouter", "grok-auth"]
    /// Ranked first on the OpenAI rail. Not a whitelist — every advertised
    /// model remains selectable under More models.
    public static let preferredOpenAIModelOrder = [
        "gpt-5.6-sol",
        "gpt-5.6-sol-1m",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
    ]
    public static let preferredOpenAIModelLabels: [String: String] = [
        "gpt-5.6-sol": "GPT-5.6 Sol",
        "gpt-5.6-sol-1m": "GPT-5.6 Sol 1M",
        "gpt-5.6-terra": "GPT-5.6 Terra",
        "gpt-5.6-luna": "GPT-5.6 Luna",
        "gpt-5.5": "GPT-5.5",
    ]
    public static let managedByServer = "Managed by your V Bot server."
    public static let refreshModels = "Refresh models"

    public static let namedLabels: [String: String] = [
        "openai": "OpenAI",
        "claude": "Claude",
        "cursor": "Cursor",
        "openrouter": "OpenRouter",
        "grok-auth": "Grok Auth",
    ]

    public static func classifyProvider(instanceId: String, driverKind: String, modelId: String) -> String {
        if isGrokAuthDriver(driverKind, instanceId: instanceId) { return "grok-auth" }
        if isOpenRouterDriver(driverKind, instanceId: instanceId) { return "openrouter" }
        if modelId.contains("/"),
           !isOpenCodeDriver(driverKind, instanceId: instanceId),
           !isCursorDriver(driverKind, instanceId: instanceId) {
            return "openrouter"
        }
        if isCursorAutoModelId(modelId), isCursorDriver(driverKind, instanceId: instanceId) { return "cursor" }
        if isComposerModelId(modelId) { return "cursor" }
        if isOpenAiModelId(modelId) || isCodexDriver(driverKind, instanceId: instanceId) { return "openai" }
        if isClaudeModelId(modelId) || isClaudeDriver(driverKind, instanceId: instanceId) { return "claude" }
        if isCursorDriver(driverKind, instanceId: instanceId) { return "cursor" }
        return remainingProviderId(driverKind: driverKind, instanceId: instanceId)
    }

    public static func providerLabel(id: String, displayName: String = "", driverKind: String = "") -> String {
        if let named = namedLabels[id] { return named }
        if id == "google" { return "Google" }
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        let driver = driverKind.trimmingCharacters(in: .whitespacesAndNewlines)
        if !driver.isEmpty { return driver }
        return AdvertisedModelCatalog.displayModelLabel(id)
    }

    public static func providerMarkKey(_ id: String) -> String {
        switch id {
        case "grok-auth": return "grok"
        case "google": return "gemini"
        default: return id
        }
    }

    public static func normalizeModelLabel(modelId: String, label: String, providerId: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = modelBase(modelId)
        if providerId == "openai", let preferred = preferredOpenAIModelLabels[modelId] {
            return preferred
        }
        if providerId == "cursor", id == "auto" || id == "default" || trimmed.lowercased() == "auto" {
            return "Cursor Auto"
        }
        if !trimmed.isEmpty { return trimmed }
        return AdvertisedModelCatalog.displayModelLabel(modelId)
    }

    public static func orderProviders(_ providers: [MobileCatalogProvider]) -> [MobileCatalogProvider] {
        var byId = Dictionary(uniqueKeysWithValues: providers.map { ($0.id, $0) })
        var ordered: [MobileCatalogProvider] = []
        for id in namedOrder {
            if let named = byId.removeValue(forKey: id) {
                ordered.append(named)
            }
        }
        let remaining = byId.values.sorted {
            if $0.label != $1.label { return $0.label < $1.label }
            return $0.id < $1.id
        }
        return ordered + remaining
    }

    public static func catalog(from instances: [Instance]) -> MobileProviderCatalog {
        var groups: [String: MobileCatalogProvider] = [:]
        for instance in instances {
            for option in instance.models.options {
                let providerId = classifyProvider(
                    instanceId: instance.instanceId,
                    driverKind: instance.driverKind,
                    modelId: option.id
                )
                guard shouldInclude(
                    option: option,
                    providerId: providerId,
                    instanceId: instance.instanceId,
                    driverKind: instance.driverKind,
                    snapshot: instance.snapshot
                ) else { continue }
                var group = groups[providerId] ?? MobileCatalogProvider(
                    id: providerId,
                    label: providerLabel(
                        id: providerId,
                        displayName: instance.displayName ?? "",
                        driverKind: instance.driverKind
                    ),
                    markKey: providerMarkKey(providerId),
                    models: []
                )
                if group.models.contains(where: { $0.instanceId == instance.instanceId && $0.id == option.id }) {
                    groups[providerId] = group
                    continue
                }
                group.models.append(
                    MobileCatalogModel(
                        id: option.id,
                        label: normalizeModelLabel(modelId: option.id, label: option.label, providerId: providerId),
                        instanceId: instance.instanceId,
                        isDefault: option.id == instance.models.default
                    )
                )
                groups[providerId] = group
            }
        }
        return MobileProviderCatalog(
            managedBy: managedByServer,
            providers: orderProviders(Array(groups.values))
                .map { provider in
                    guard provider.id == "openai" else { return provider }
                    let rank = Dictionary(uniqueKeysWithValues: preferredOpenAIModelOrder.enumerated().map { ($1, $0) })
                    return MobileCatalogProvider(
                        id: provider.id,
                        label: provider.label,
                        markKey: provider.markKey,
                        models: provider.models.sorted {
                            (rank[$0.id] ?? Int.max) < (rank[$1.id] ?? Int.max)
                        }
                    )
                }
                .filter { !$0.models.isEmpty }
        )
    }

    public static func groupedInstances(advertised: [Instance], selection: ModelSelection) -> [Instance] {
        let groups = catalog(from: advertised).providers
        let advertisedById = Dictionary(uniqueKeysWithValues: advertised.map { ($0.instanceId, $0) })
        var rows = groups.map { group in
            instance(from: group, advertisedById: advertisedById)
        }
        if !selection.instanceId.isEmpty,
           !rows.contains(where: { contains(selection, in: $0) }),
           shouldDisplaySelection(selection, advertised: advertised) {
            rows.append(AdvertisedModelCatalog.orphanInstance(selection: selection))
        }
        return rows
    }

    public static func resolvedRail(
        advertised: [Instance],
        selection: ModelSelection,
        activeRailId: String?
    ) -> Instance? {
        let rails = groupedInstances(advertised: advertised, selection: selection)
        if let activeRailId, let match = rails.first(where: { $0.instanceId == activeRailId }) {
            return match
        }
        if let match = rails.first(where: { contains(selection, in: $0) }) {
            return match
        }
        return rails.first
    }

    public static func modelsDisabled(
        advertised: [Instance],
        selection: ModelSelection,
        activeRailId: String?,
        hostWideEngine: Bool
    ) -> Bool {
        let rail = resolvedRail(advertised: advertised, selection: selection, activeRailId: activeRailId)
        return ModelSelectionPolicy.modelsDisabled(for: rail, hostWideEngine: hostWideEngine)
    }

    public static func rowIdentity(_ model: MobileCatalogModel) -> String {
        ModelFamilyPolicy.compositeId(instanceId: model.instanceId, modelId: model.id)
    }

    /// Provider tabs only change browsing state. They never rewrite the draft
    /// or persisted model.
    public static func selectionAfterProviderTap(
        current: ModelSelection,
        tapped: Instance,
        advertised: [Instance]
    ) -> ModelSelection? {
        _ = (current, tapped, advertised)
        return nil
    }

    public static func selectionAfterModelTap(
        current: ModelSelection,
        rail: Instance?,
        modelId: String,
        sourceInstanceId: String? = nil
    ) -> ModelSelection? {
        guard let rail, rail.allowsModelChange else { return nil }
        let matches = rail.models.options.filter { $0.id == modelId }
        let option: ModelOption?
        if let sourceInstanceId {
            option = matches.first { ($0.instanceId ?? rail.instanceId) == sourceInstanceId }
        } else if matches.count <= 1 {
            option = matches.first
        } else {
            option = matches.first { ($0.instanceId ?? rail.instanceId) == current.instanceId }
        }
        guard let option else { return nil }
        let instanceId = option.instanceId ?? rail.instanceId
        return ModelSelection(instanceId: instanceId, model: modelId, effort: current.effort)
    }

    public static func resolveSelection(_ selection: ModelSelection, in advertised: [Instance]) -> ModelSelection {
        let catalog = catalog(from: advertised)
        if selectionExists(selection, in: catalog) { return selection }

        let sameInstance = catalog.providers.flatMap { $0.models.filter { $0.instanceId == selection.instanceId } }
        if let fallback = firstModel(sameInstance) {
            return ModelSelection(instanceId: fallback.instanceId, model: fallback.id, effort: selection.effort)
        }

        if let provider = catalog.providers.first(where: { $0.models.contains(where: { $0.instanceId == selection.instanceId }) }),
           let fallback = firstModel(provider.models) {
            return ModelSelection(instanceId: fallback.instanceId, model: fallback.id, effort: selection.effort)
        }

        if let fallback = catalog.providers.first.flatMap({ firstModel($0.models) }) {
            return ModelSelection(instanceId: fallback.instanceId, model: fallback.id, effort: selection.effort)
        }
        return selection
    }

    public static func serializedCatalogOmitsSecrets(_ catalog: MobileProviderCatalog) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(catalog),
              let object = try? JSONSerialization.jsonObject(with: data)
        else { return false }
        return !containsSecretKey(object)
    }

    public static func isEmpty(advertised: [Instance], selection: ModelSelection) -> Bool {
        AdvertisedModelCatalog.isEmpty(groupedInstances(advertised: advertised, selection: selection))
    }

    /// Missing current selections stay visible as "Current model unavailable".
    public static func shouldDisplaySelection(_ selection: ModelSelection, advertised: [Instance]) -> Bool {
        _ = (selection, advertised)
        return true
    }

    private static func instance(from group: MobileCatalogProvider, advertisedById: [String: Instance]) -> Instance {
        let sources = group.models.compactMap { advertisedById[$0.instanceId] }
        let available = sources.first(where: { $0.snapshot.isAvailable }) ?? sources.first
        let defaultOption = group.models.first(where: \.isDefault) ?? group.models.first
        return Instance(
            instanceId: group.id,
            driverKind: group.markKey,
            displayName: group.label,
            snapshot: available?.snapshot ?? ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(
                default: defaultOption?.id ?? "",
                options: group.models.map {
                    ModelOption(id: $0.id, label: $0.label, instanceId: $0.instanceId)
                }
            ),
            capabilities: available?.capabilities,
            instanceSelectable: true,
            modelSelectable: true
        )
    }

    private static func contains(_ selection: ModelSelection, in rail: Instance) -> Bool {
        if rail.models.options.contains(where: { option in
            (option.instanceId ?? rail.instanceId) == selection.instanceId && option.id == selection.model
        }) {
            return true
        }
        return rail.instanceId == selection.instanceId
    }

    private static func defaultOption(in rail: Instance) -> ModelOption? {
        if let match = rail.models.options.first(where: { $0.id == rail.models.default }) {
            return match
        }
        return rail.models.options.first
    }

    private static func selectionExists(_ selection: ModelSelection, in catalog: MobileProviderCatalog) -> Bool {
        catalog.providers.contains { provider in
            provider.models.contains { $0.instanceId == selection.instanceId && $0.id == selection.model }
        }
    }

    private static func firstModel(_ models: [MobileCatalogModel]) -> MobileCatalogModel? {
        models.first(where: \.isDefault) ?? models.first
    }

    private static func shouldInclude(
        option: ModelOption,
        providerId: String,
        instanceId: String,
        driverKind: String,
        snapshot: ProviderSnapshot
    ) -> Bool {
        _ = (option, providerId, instanceId, driverKind, snapshot)
        return true
    }

    private static func containsSecretKey(_ value: Any) -> Bool {
        if let object = value as? [String: Any] {
            for (key, inner) in object {
                if isSecretKey(key) { return true }
                if containsSecretKey(inner) { return true }
            }
        } else if let array = value as? [Any] {
            return array.contains(where: containsSecretKey)
        }
        return false
    }

    private static func isSecretKey(_ key: String) -> Bool {
        let lower = key.lowercased()
        if ["cli", "clidefault", "clicandidates", "install", "environment", "config", "apikey", "api_key", "key"].contains(lower) {
            return true
        }
        return lower.contains("token") || lower.contains("secret") || lower.contains("password") || lower.contains("authorization")
    }

    private static func compact(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizeKey(_ value: String) -> String {
        compact(value)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: "agent", with: "", options: [.caseInsensitive, .anchored, .backwards])
    }

    private static func driverToken(_ driverKind: String, instanceId: String) -> String {
        "\(normalizeKey(driverKind)) \(normalizeKey(instanceId))"
    }

    private static func modelBase(_ modelId: String) -> String {
        let normalized = normalizeKey(modelId)
        return String(normalized.split(separator: "[", maxSplits: 1, omittingEmptySubsequences: false).first ?? Substring(normalized))
    }

    public static func isOpenAiModelId(_ modelId: String) -> Bool {
        let id = modelBase(modelId)
        if id.hasPrefix("gpt-") || id.hasPrefix("chatgpt") || id.hasPrefix("o1") || id.hasPrefix("o3") || id.hasPrefix("o4") {
            return true
        }
        return id.contains("codex")
    }

    public static func isClaudeModelId(_ modelId: String) -> Bool {
        modelBase(modelId).hasPrefix("claude")
    }

    public static func isCursorAutoModelId(_ modelId: String) -> Bool {
        let id = modelBase(modelId)
        return id == "auto" || id == "default"
    }

    public static func isComposerModelId(_ modelId: String) -> Bool {
        modelBase(modelId).hasPrefix("composer")
    }

    private static func isGrokAuthDriver(_ driverKind: String, instanceId: String) -> Bool {
        let raw = "\(driverKind) \(instanceId)".lowercased().replacingOccurrences(of: "_", with: "-")
        return raw.range(of: "grok-?agent", options: .regularExpression) != nil
    }

    private static func isOpenRouterDriver(_ driverKind: String, instanceId: String) -> Bool {
        let token = driverToken(driverKind, instanceId: instanceId)
        return token.contains("openai-compat") || token.contains("openaicompat") || token.contains("openrouter")
    }

    private static func isOpenCodeDriver(_ driverKind: String, instanceId: String) -> Bool {
        driverToken(driverKind, instanceId: instanceId).contains("opencode")
    }

    private static func isCursorDriver(_ driverKind: String, instanceId: String) -> Bool {
        driverToken(driverKind, instanceId: instanceId).contains("cursor")
    }

    private static func isCodexDriver(_ driverKind: String, instanceId: String) -> Bool {
        driverToken(driverKind, instanceId: instanceId)
            .split(separator: " ")
            .contains(where: { $0 == "codex" })
    }

    private static func isDirectOpenAIInstance(instanceId: String, driverKind: String) -> Bool {
        isCodexDriver(driverKind, instanceId: instanceId)
            || normalizeKey(instanceId) == "openai"
            || normalizeKey(driverKind) == "openai"
    }

    private static func isClaudeDriver(_ driverKind: String, instanceId: String) -> Bool {
        driverToken(driverKind, instanceId: instanceId).contains("claude")
    }

    private static func remainingProviderId(driverKind: String, instanceId: String) -> String {
        let driver = normalizeKey(driverKind).replacingOccurrences(of: "-", with: "")
        if driver.contains("gemini") || instanceId.lowercased().contains("gemini") { return "google" }
        let fallback = normalizeKey(driverKind)
        if !fallback.isEmpty { return fallback }
        let instance = normalizeKey(instanceId)
        return instance.isEmpty ? "other" : instance
    }
}
