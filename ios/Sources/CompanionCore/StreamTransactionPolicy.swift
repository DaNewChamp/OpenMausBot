import Foundation

/// Generation-gated hello / hydrate / unauthorized commits for the SSE
/// session. Fetch may run on a stale task; live mutations apply only when
/// `shouldCommit` is true after that work returns.
public enum StreamTransactionPolicy: Sendable {
    public struct HelloCommit: Equatable, Sendable {
        public var hydrateFleet: Bool
        public var persistPins: Bool
        public var refreshEngineCatalog: Bool
        public var resetCoalescer: Bool
        public var applyHello: Bool
        public var setPreviouslyLive: Bool
        public var rememberWorkingRoute: Bool
        public var startEndpointRefresh: Bool

        public var shouldApply: Bool { applyHello }
    }

    public static func shouldCommit(startedGeneration: Int, currentGeneration: Int) -> Bool {
        ConnectionResiliencePolicy.shouldApply(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
    }

    public static func hello(
        startedGeneration: Int,
        currentGeneration: Int,
        resumed: Bool
    ) -> HelloCommit {
        let live = shouldCommit(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
        let cold = live && !resumed
        return HelloCommit(
            hydrateFleet: cold,
            persistPins: cold,
            refreshEngineCatalog: cold,
            resetCoalescer: live,
            applyHello: live,
            setPreviouslyLive: live,
            rememberWorkingRoute: live,
            startEndpointRefresh: live
        )
    }

    public static func nextPreviouslyLive(current: Bool, commit: HelloCommit) -> Bool {
        commit.setPreviouslyLive ? true : current
    }

    public static func unauthorizedClearsPreviouslyLive(
        startedGeneration: Int,
        currentGeneration: Int
    ) -> Bool {
        shouldCommit(startedGeneration: startedGeneration, currentGeneration: currentGeneration)
    }

    public static func nextPreviouslyLiveOnUnauthorized(
        current: Bool,
        startedGeneration: Int,
        currentGeneration: Int
    ) -> Bool {
        unauthorizedClearsPreviouslyLive(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        ) ? false : current
    }
}
