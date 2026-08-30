import Foundation

/// Pure EngineSync refresh and catalog-source rules. Views and Session only
/// apply a result when it still matches the newest request.
public enum EngineSyncPolicy: Sendable {
    public static let reconstructedUnavailableFallback =
        "The selected engine is not ready, so model changes cannot fall back to another engine."

    public static func shouldApply(startedGeneration: Int, currentGeneration: Int) -> Bool {
        startedGeneration == currentGeneration
    }

    public enum CatalogSource: Equatable, Sendable {
        case advertised
        case reconstructed
        case reconstructedUnavailable(String)
        case unknown
    }

    public static func catalogSource(for sync: VBotEngineSync?) -> CatalogSource {
        guard let sync else { return .unknown }
        if sync.usesReconstructedMutations {
            if sync.reconstructedMutationsReady {
                return .reconstructed
            }
            return .reconstructedUnavailable(sync.fallbackReason ?? reconstructedUnavailableFallback)
        }
        return .advertised
    }

    /// Reconstructed engines historically share one provider/model across the
    /// host unless the harness advertises per-bot selection.
    public static func hostWideSelection(_ sync: VBotEngineSync?) -> Bool {
        guard let sync, sync.usesReconstructedMutations else { return false }
        if let router = sync.router { return router.perBotSelection == false }
        if let providers = sync.providers { return providers.perBotSelection == false }
        return true
    }

    public static func instanceDisappeared(selectedId: String, advertised: [Instance]) -> Bool {
        AdvertisedModelCatalog.instance(id: selectedId, in: advertised) == nil
    }

    public static func modelAvailable(_ model: String, in instance: Instance?) -> Bool {
        guard let instance else { return false }
        return instance.models.options.contains { $0.id == model }
    }

    public static func fallbackReason(for sync: VBotEngineSync) -> String? {
        guard sync.fallback else { return nil }
        let reason = sync.fallbackReason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return reason.isEmpty ? nil : reason
    }

    public static func displayEngineName(_ sync: VBotEngineSync) -> String {
        sync.fallback ? sync.servingEngine.displayName : sync.selectedEngine.displayName
    }

    public static func nextGeneration(after current: Int) -> Int {
        current &+ 1
    }
}
