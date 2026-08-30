import Foundation

/// Last-authoritative catalog refresh. Overlapping loads bump generation;
/// only the newest completion may clear `refreshing` or publish rows.
public struct ModelCatalogRefreshGate: Equatable, Sendable {
    public private(set) var generation: Int
    public private(set) var refreshing: Bool

    public init(generation: Int = 0, refreshing: Bool = false) {
        self.generation = generation
        self.refreshing = refreshing
    }

    public mutating func beginLoad() -> Int {
        generation = EngineSyncPolicy.nextGeneration(after: generation)
        refreshing = true
        return generation
    }

    /// Pairing and sign-out drop in-flight catalog work without leaving the
    /// picker spinning.
    public mutating func invalidate() {
        generation = EngineSyncPolicy.nextGeneration(after: generation)
        refreshing = false
    }

    @discardableResult
    public mutating func finishLoad(startedGeneration: Int) -> Bool {
        guard EngineSyncPolicy.shouldApply(
            startedGeneration: startedGeneration,
            currentGeneration: generation
        ) else {
            return false
        }
        refreshing = false
        return true
    }
}

/// Picker/session rules for catalog overlap. Views observe session
/// refreshing so a cancelled waiter cannot strand “Refreshing models.”
public enum ModelCatalogLoadPolicy: Sendable {
    public static func waiterStillLoading(
        resultCancelled: Bool,
        sessionRefreshing: Bool
    ) -> Bool {
        resultCancelled && sessionRefreshing
    }

    public static func hostLoading(localLoading: Bool, sessionRefreshing: Bool) -> Bool {
        localLoading || sessionRefreshing
    }

    public static func localLoadingAfterSessionPublish(sessionRefreshing: Bool) -> Bool {
        sessionRefreshing
    }

    /// Empty incoming rows during an in-flight refresh must not wipe a warm
    /// cache. A finished refresh may show an honest empty catalog.
    public static func shouldReplaceDisplayedCatalog(
        incomingIsEmpty: Bool,
        sessionRefreshing: Bool
    ) -> Bool {
        !incomingIsEmpty || !sessionRefreshing
    }
}
