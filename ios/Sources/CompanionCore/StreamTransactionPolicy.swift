import Foundation

/// Generation-gated hello / hydrate / unauthorized commits for the SSE
/// session. Fetch may run on a stale task; live mutations apply only when
/// `shouldCommit` is true after that work returns.
public enum StreamTransactionPolicy: Sendable {
    /// How a live mutation is authorized relative to the SSE generation.
    /// There is no optional generation: stream work names a snapshot, and
    /// user-initiated writes name `.explicit`.
    public enum Authority: Equatable, Sendable {
        /// Apply only while this stream generation is still current.
        case requiredGeneration(Int)
        /// Non-stream user write (explicit profile save, picker catalog load).
        case explicit
    }

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

    /// Helper hydrate after `fetchFleet` (interrupted model-write reconcile).
    /// Does not bump the authoritative revision; that belongs to hello and
    /// notification commits that replace the live session snapshot.
    public struct HelperHydrateCommit: Equatable, Sendable {
        public var applyFleet: Bool
        public var persistPins: Bool
        public var persistAppearance: Bool
        public var retryAppearance: Bool
        public var refreshEngineCatalog: Bool

        public var shouldApply: Bool { applyFleet }
    }

    public struct NotificationCommit: Equatable, Sendable {
        public var applyFleet: Bool
        public var bumpAuthoritativeRevision: Bool
        public var continueNavigation: Bool
    }

    public static func shouldCommit(startedGeneration: Int, currentGeneration: Int) -> Bool {
        ConnectionResiliencePolicy.shouldApply(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
    }

    public static func allows(_ authority: Authority, currentGeneration: Int) -> Bool {
        switch authority {
        case let .requiredGeneration(started):
            return shouldCommit(
                startedGeneration: started,
                currentGeneration: currentGeneration
            )
        case .explicit:
            return true
        }
    }

    /// Snapshot `startedGeneration` before `fetchFleet`; apply only if it is
    /// still current when the response returns.
    public static func helperHydrate(
        startedGeneration: Int,
        currentGeneration: Int
    ) -> HelperHydrateCommit {
        let live = shouldCommit(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
        return HelperHydrateCommit(
            applyFleet: live,
            persistPins: live,
            persistAppearance: live,
            retryAppearance: live,
            refreshEngineCatalog: live
        )
    }

    public static func notification(
        startedGeneration: Int,
        currentGeneration: Int
    ) -> NotificationCommit {
        let live = shouldCommit(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
        return NotificationCommit(
            applyFleet: live,
            bumpAuthoritativeRevision: live,
            continueNavigation: live
        )
    }

    public static func shouldApplyAppearanceRetry(
        authority: Authority,
        currentGeneration: Int
    ) -> Bool {
        allows(authority, currentGeneration: currentGeneration)
    }

    public static func shouldClearUnconfirmedWrites(
        startedGeneration: Int,
        currentGeneration: Int
    ) -> Bool {
        shouldCommit(
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
