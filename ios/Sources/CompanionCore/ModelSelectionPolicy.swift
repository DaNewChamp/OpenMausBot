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

public enum ModelCatalogPresentation: Equatable, Sendable {
    case loading
    case error(String)
    case empty
    case catalog(cachedOffline: Bool)

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
            if hasCache { return .catalog(cachedOffline: true) }
            if let error { return .error(error) }
            return .empty
        }
        if let error, !hasCache {
            return .error(error)
        }
        if !loading, error == nil, AdvertisedModelCatalog.isEmpty(instances) {
            return .empty
        }
        return .catalog(cachedOffline: false)
    }

    public var selectionDisabled: Bool {
        switch self {
        case .loading, .error, .empty:
            return true
        case let .catalog(cachedOffline):
            return cachedOffline
        }
    }
}
