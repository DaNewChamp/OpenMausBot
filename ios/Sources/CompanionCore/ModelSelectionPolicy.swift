import Foundation

/// Busy-turn, catalog-surface, and revision rules for engine/model selection.
/// The catalog itself stays whatever the harness advertised — this only gates
/// *when* a switch is allowed and how the picker presents load/empty/offline.
public enum ModelSelectionPolicy: Sendable {
    public static let busyExplanation = "Interrupt this agent before switching models."
    public static let idleHint = "Changes apply to the next message."
    public static let emptyCatalogExplanation = "No models on computer"
    public static let engineEmptyExplanation = "No models advertised for this engine."
    public static let hostWideHint =
        "This engine uses one provider and model for every agent on this computer."
    public static let providerKeepsLocalModel = "This provider keeps its local model."
    public static let fastModeHint =
        "Uses a quicker model and lower reasoning when this engine supports it."

    public static func allowsSwitch(
        working: Bool,
        saving: Bool = false,
        catalogLoading: Bool = false
    ) -> Bool {
        !working && !saving && !catalogLoading
    }

    public static func footerHint(working: Bool) -> String {
        working ? busyExplanation : idleHint
    }

    public static func footerHint(
        working: Bool,
        canEdit: Bool,
        hostWide: Bool
    ) -> String {
        if !canEdit { return CalmSurfacePolicy.reconnectToEdit }
        if working { return busyExplanation }
        if hostWide { return hostWideHint }
        return idleHint
    }

    public static func shouldApplyResponse(requestRevision: Int, currentRevision: Int) -> Bool {
        EngineSyncPolicy.shouldApply(startedGeneration: requestRevision, currentGeneration: currentRevision)
    }

    public static func showsEffortPicker(levels: [String], hostWideEngine: Bool) -> Bool {
        !levels.isEmpty && !hostWideEngine
    }

    public static func modelsDisabled(for instance: Instance?, hostWideEngine: Bool) -> Bool {
        guard let instance else { return hostWideEngine }
        return !instance.allowsModelChange
    }

    /// Revert unsaved picker values when a turn starts; keep them when it ends.
    public static func shouldRevertDraft(wasWorking: Bool, isWorking: Bool) -> Bool {
        !wasWorking && isWorking
    }
}

/// Rail resolution for chat/profile/settings pickers. Lookups use the display
/// catalog (advertised + synthetic orphan) so a missing engine cannot show
/// another engine's models or rewrite `instanceId` on a model tap.
public enum ModelPickerRailPolicy: Sendable {
    public static func displayInstances(advertised: [Instance], selection: ModelSelection) -> [Instance] {
        AdvertisedModelCatalog.displayCatalog(advertised: advertised, selection: selection)
    }

    public static func isEmpty(advertised: [Instance], selection: ModelSelection) -> Bool {
        AdvertisedModelCatalog.isEmpty(displayInstances(advertised: advertised, selection: selection))
    }

    public static func resolvedRail(
        advertised: [Instance],
        selection: ModelSelection,
        activeRailId: String?
    ) -> Instance? {
        let rails = displayInstances(advertised: advertised, selection: selection)
        let activeId = activeRailId ?? selection.instanceId
        return AdvertisedModelCatalog.instance(id: activeId, in: rails)
            ?? AdvertisedModelCatalog.instance(id: selection.instanceId, in: rails)
            ?? rails.first
    }

    public static func modelsDisabled(
        advertised: [Instance],
        selection: ModelSelection,
        activeRailId: String?,
        hostWideEngine: Bool
    ) -> Bool {
        let rail = resolvedRail(advertised: advertised, selection: selection, activeRailId: activeRailId)
        if ModelSelectionPolicy.modelsDisabled(for: rail, hostWideEngine: hostWideEngine) {
            return true
        }
        guard let rail else { return hostWideEngine }
        return rail.instanceId != selection.instanceId
    }

    /// Model rows never change `instanceId`. That only happens via an engine chip.
    public static func selectionAfterModelTap(
        current: ModelSelection,
        rail: Instance?,
        modelId: String
    ) -> ModelSelection? {
        guard let rail, rail.instanceId == current.instanceId, rail.allowsModelChange else {
            return nil
        }
        return ModelSelection(instanceId: current.instanceId, model: modelId, effort: current.effort)
    }

    public static func selectionAfterEngineTap(
        current: ModelSelection,
        tapped: Instance,
        advertised: [Instance]
    ) -> ModelSelection? {
        guard tapped.allowsInstanceChange || tapped.instanceId == current.instanceId else {
            return nil
        }
        if tapped.instanceId == current.instanceId {
            return current
        }
        return ModelSelection(
            instanceId: tapped.instanceId,
            model: AdvertisedModelCatalog.alignedModel(
                instanceId: tapped.instanceId,
                currentModel: current.model,
                in: advertised
            ),
            effort: current.effort
        )
    }
}

public enum ModelCatalogPresentation: Equatable, Sendable {
    case loading
    case error(String)
    case empty
    case catalog(cachedOffline: Bool, refreshError: String?)

    public static func surface(
        loading: Bool,
        error: String?,
        instances: [Instance],
        canEdit: Bool
    ) -> ModelCatalogPresentation {
        let hasCache = !instances.isEmpty
        if CalmSurfacePolicy.showsSkeleton(isLoading: loading, hasCachedRows: hasCache) {
            return .loading
        }
        if !canEdit {
            if hasCache { return .catalog(cachedOffline: true, refreshError: nil) }
            if let error { return .error(error) }
            return .empty
        }
        if let error, !hasCache {
            return .error(error)
        }
        if let error, hasCache {
            return .catalog(cachedOffline: true, refreshError: error)
        }
        if !loading, error == nil, AdvertisedModelCatalog.isEmpty(instances) {
            return .empty
        }
        return .catalog(cachedOffline: false, refreshError: nil)
    }

    public var selectionDisabled: Bool {
        switch self {
        case .loading, .error, .empty:
            return true
        case let .catalog(cachedOffline, refreshError):
            return cachedOffline || refreshError != nil
        }
    }

    public var refreshError: String? {
        switch self {
        case let .error(message):
            return message
        case let .catalog(_, error):
            return error
        default:
            return nil
        }
    }

    public var showsCatalogRows: Bool {
        if case .catalog = self { return true }
        return false
    }
}
