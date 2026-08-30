import XCTest
@testable import CompanionCore

final class StreamTransactionPolicyTests: XCTestCase {
    func testCurrentColdHelloCommitsHydrateAndLiveMutations() {
        let commit = StreamTransactionPolicy.hello(
            startedGeneration: 4,
            currentGeneration: 4,
            resumed: false
        )
        XCTAssertTrue(commit.hydrateFleet)
        XCTAssertTrue(commit.resetCoalescer)
        XCTAssertTrue(commit.persistPins)
        XCTAssertTrue(commit.refreshEngineCatalog)
        XCTAssertTrue(commit.applyHello)
        XCTAssertTrue(commit.setPreviouslyLive)
        XCTAssertTrue(commit.rememberWorkingRoute)
        XCTAssertTrue(commit.startEndpointRefresh)
        XCTAssertTrue(commit.shouldApply)
    }

    func testCurrentResumedHelloSkipsHydrateKeepsLiveMutations() {
        let commit = StreamTransactionPolicy.hello(
            startedGeneration: 5,
            currentGeneration: 5,
            resumed: true
        )
        XCTAssertFalse(commit.hydrateFleet)
        XCTAssertFalse(commit.persistPins)
        XCTAssertFalse(commit.refreshEngineCatalog)
        XCTAssertTrue(commit.resetCoalescer)
        XCTAssertTrue(commit.applyHello)
        XCTAssertTrue(commit.setPreviouslyLive)
        XCTAssertTrue(commit.rememberWorkingRoute)
        XCTAssertTrue(commit.startEndpointRefresh)
    }

    func testStaleHelloDiscardsEveryLiveMutation() {
        let commit = StreamTransactionPolicy.hello(
            startedGeneration: 3,
            currentGeneration: 4,
            resumed: false
        )
        XCTAssertFalse(commit.shouldApply)
        XCTAssertFalse(commit.hydrateFleet)
        XCTAssertFalse(commit.resetCoalescer)
        XCTAssertFalse(commit.persistPins)
        XCTAssertFalse(commit.refreshEngineCatalog)
        XCTAssertFalse(commit.applyHello)
        XCTAssertFalse(commit.setPreviouslyLive)
        XCTAssertFalse(commit.rememberWorkingRoute)
        XCTAssertFalse(commit.startEndpointRefresh)
    }

    func testStaleResumedHelloDoesNotMarkLiveOrRefreshRoutes() {
        let commit = StreamTransactionPolicy.hello(
            startedGeneration: 8,
            currentGeneration: 9,
            resumed: true
        )
        XCTAssertFalse(commit.applyHello)
        XCTAssertFalse(commit.setPreviouslyLive)
        XCTAssertFalse(commit.rememberWorkingRoute)
        XCTAssertFalse(commit.startEndpointRefresh)
        XCTAssertFalse(commit.resetCoalescer)
    }

    func testFirstConnectCopyStaysConnectingUntilCurrentHelloCommits() {
        XCTAssertFalse(
            StreamTransactionPolicy.nextPreviouslyLive(
                current: false,
                commit: StreamTransactionPolicy.hello(
                    startedGeneration: 1,
                    currentGeneration: 2,
                    resumed: false
                )
            )
        )
        XCTAssertTrue(
            StreamTransactionPolicy.nextPreviouslyLive(
                current: false,
                commit: StreamTransactionPolicy.hello(
                    startedGeneration: 2,
                    currentGeneration: 2,
                    resumed: false
                )
            )
        )
        XCTAssertTrue(
            StreamTransactionPolicy.nextPreviouslyLive(
                current: true,
                commit: StreamTransactionPolicy.hello(
                    startedGeneration: 2,
                    currentGeneration: 2,
                    resumed: true
                )
            )
        )
    }

    func testReconnectCopyRequiresPreviouslyLiveFromACommittedHello() {
        let first = ConnectionResiliencePolicy.banner(
            previouslyLive: StreamTransactionPolicy.nextPreviouslyLive(
                current: false,
                commit: StreamTransactionPolicy.hello(
                    startedGeneration: 1,
                    currentGeneration: 1,
                    resumed: false
                )
            ),
            connecting: true
        )
        XCTAssertEqual(first.kind, .reconnecting)

        let staleDidNotConnect = ConnectionResiliencePolicy.banner(
            previouslyLive: StreamTransactionPolicy.nextPreviouslyLive(
                current: false,
                commit: StreamTransactionPolicy.hello(
                    startedGeneration: 1,
                    currentGeneration: 2,
                    resumed: false
                )
            ),
            connecting: true
        )
        XCTAssertEqual(staleDidNotConnect.kind, .connecting)
        XCTAssertEqual(staleDidNotConnect.text, ConnectionResiliencePolicy.connectingCopy)
    }

    func testStaleUnauthorizedDoesNotClearPreviouslyLive() {
        XCTAssertTrue(
            StreamTransactionPolicy.nextPreviouslyLiveOnUnauthorized(
                current: true,
                startedGeneration: 3,
                currentGeneration: 4
            )
        )
        XCTAssertFalse(
            StreamTransactionPolicy.unauthorizedClearsPreviouslyLive(
                startedGeneration: 3,
                currentGeneration: 4
            )
        )
    }

    func testCurrentUnauthorizedClearsPreviouslyLive() {
        XCTAssertFalse(
            StreamTransactionPolicy.nextPreviouslyLiveOnUnauthorized(
                current: true,
                startedGeneration: 4,
                currentGeneration: 4
            )
        )
        XCTAssertTrue(
            StreamTransactionPolicy.unauthorizedClearsPreviouslyLive(
                startedGeneration: 4,
                currentGeneration: 4
            )
        )
    }

    func testSeamRecorderDropsStaleHydrateThenAppliesCurrentResume() {
        var seam = StreamTransactionSeam()
        seam.apply(
            StreamTransactionPolicy.hello(
                startedGeneration: 1,
                currentGeneration: 2,
                resumed: false
            )
        )
        XCTAssertEqual(seam, StreamTransactionSeam())

        seam.apply(
            StreamTransactionPolicy.hello(
                startedGeneration: 2,
                currentGeneration: 2,
                resumed: true
            )
        )
        XCTAssertFalse(seam.hydrated)
        XCTAssertFalse(seam.persistedPins)
        XCTAssertFalse(seam.catalogRefreshed)
        XCTAssertTrue(seam.resetCoalescer)
        XCTAssertTrue(seam.appliedHello)
        XCTAssertTrue(seam.previouslyLive)
        XCTAssertTrue(seam.rememberedRoute)
        XCTAssertTrue(seam.startedEndpointRefresh)

        seam.applyUnauthorized(
            startedGeneration: 2,
            currentGeneration: 3
        )
        XCTAssertTrue(seam.previouslyLive)
    }

    func testHelperHydrateAppliesFleetPinsAppearanceAndCatalogWhenCurrent() {
        let commit = StreamTransactionPolicy.helperHydrate(
            startedGeneration: 4,
            currentGeneration: 4
        )
        XCTAssertTrue(commit.shouldApply)
        XCTAssertTrue(commit.applyFleet)
        XCTAssertTrue(commit.persistPins)
        XCTAssertTrue(commit.persistAppearance)
        XCTAssertTrue(commit.retryAppearance)
        XCTAssertTrue(commit.refreshEngineCatalog)
    }

    func testStaleHelperHydrateDropsEveryLiveMutation() {
        let commit = StreamTransactionPolicy.helperHydrate(
            startedGeneration: 4,
            currentGeneration: 5
        )
        XCTAssertFalse(commit.shouldApply)
        XCTAssertFalse(commit.applyFleet)
        XCTAssertFalse(commit.persistPins)
        XCTAssertFalse(commit.persistAppearance)
        XCTAssertFalse(commit.retryAppearance)
        XCTAssertFalse(commit.refreshEngineCatalog)
    }

    func testHelperHydrateSeamDoesNotBumpRevisionAndClearsUnconfirmedOnlyWhenCurrent() {
        var seam = HelperHydrateSeam()
        seam.apply(startedGeneration: 4, currentGeneration: 5)
        seam.finishUnconfirmed(startedGeneration: 4, currentGeneration: 5)
        XCTAssertEqual(seam, HelperHydrateSeam())

        seam.apply(startedGeneration: 5, currentGeneration: 5)
        seam.finishUnconfirmed(startedGeneration: 5, currentGeneration: 5)
        XCTAssertTrue(seam.appliedFleet)
        XCTAssertTrue(seam.persistedPins)
        XCTAssertTrue(seam.persistedAppearance)
        XCTAssertTrue(seam.retriedAppearance)
        XCTAssertTrue(seam.refreshedEngineCatalog)
        XCTAssertFalse(seam.bumpedRevision)
        XCTAssertTrue(seam.clearedUnconfirmed)
    }

    func testUnconfirmedWritesStayWhenHydrateGenerationIsStale() {
        XCTAssertTrue(
            StreamTransactionPolicy.shouldClearUnconfirmedWrites(
                startedGeneration: 6,
                currentGeneration: 6
            )
        )
        XCTAssertFalse(
            StreamTransactionPolicy.shouldClearUnconfirmedWrites(
                startedGeneration: 6,
                currentGeneration: 7
            )
        )
    }

    func testCurrentNotificationHydrateBumpsRevisionAndContinuesNavigation() {
        let commit = StreamTransactionPolicy.notification(
            startedGeneration: 2,
            currentGeneration: 2
        )
        XCTAssertTrue(commit.applyFleet)
        XCTAssertTrue(commit.bumpAuthoritativeRevision)
        XCTAssertTrue(commit.continueNavigation)
    }

    func testStaleNotificationHydrateDoesNotBumpRevisionOrNavigate() {
        let commit = StreamTransactionPolicy.notification(
            startedGeneration: 2,
            currentGeneration: 3
        )
        XCTAssertFalse(commit.applyFleet)
        XCTAssertFalse(commit.bumpAuthoritativeRevision)
        XCTAssertFalse(commit.continueNavigation)
    }

    func testNotificationHydrateSeamDropsStaleThenCommitsCurrent() {
        var seam = NotificationHydrateSeam()
        seam.apply(startedGeneration: 8, currentGeneration: 9)
        XCTAssertEqual(seam, NotificationHydrateSeam())

        seam.apply(startedGeneration: 9, currentGeneration: 9)
        XCTAssertTrue(seam.appliedFleet)
        XCTAssertTrue(seam.bumpedRevision)
        XCTAssertTrue(seam.continuedNavigation)
    }

    func testAppearanceRetryRequiresMatchingStreamGeneration() {
        XCTAssertTrue(
            StreamTransactionPolicy.shouldApplyAppearanceRetry(
                authority: .requiredGeneration(7),
                currentGeneration: 7
            )
        )
        XCTAssertFalse(
            StreamTransactionPolicy.shouldApplyAppearanceRetry(
                authority: .requiredGeneration(7),
                currentGeneration: 8
            )
        )
    }

    func testExplicitAppearanceSaveIsAllowedRegardlessOfGeneration() {
        XCTAssertTrue(
            StreamTransactionPolicy.shouldApplyAppearanceRetry(
                authority: .explicit,
                currentGeneration: 1
            )
        )
        XCTAssertTrue(
            StreamTransactionPolicy.shouldApplyAppearanceRetry(
                authority: .explicit,
                currentGeneration: 99
            )
        )
        XCTAssertTrue(
            StreamTransactionPolicy.allows(.explicit, currentGeneration: 0)
        )
    }

    func testAppearanceRetrySeamDropsStalePatchThenAppliesExplicitSave() {
        var seam = AppearanceRetrySeam()
        seam.applyPatch(authority: .requiredGeneration(3), currentGeneration: 4)
        XCTAssertFalse(seam.appliedBot)
        XCTAssertFalse(seam.persisted)

        seam.applyPatch(authority: .explicit, currentGeneration: 4)
        XCTAssertTrue(seam.appliedBot)
        XCTAssertTrue(seam.persisted)
    }
}

/// Records the mutations Session must gate on `StreamTransactionPolicy`.
/// This is the testable stand-in for `Session.run` / `hydrate` apply order.
struct StreamTransactionSeam: Equatable {
    var hydrated = false
    var persistedPins = false
    var catalogRefreshed = false
    var resetCoalescer = false
    var appliedHello = false
    var previouslyLive = false
    var rememberedRoute = false
    var startedEndpointRefresh = false

    mutating func apply(_ commit: StreamTransactionPolicy.HelloCommit) {
        if commit.hydrateFleet { hydrated = true }
        if commit.persistPins { persistedPins = true }
        if commit.refreshEngineCatalog { catalogRefreshed = true }
        if commit.resetCoalescer { resetCoalescer = true }
        if commit.applyHello { appliedHello = true }
        previouslyLive = StreamTransactionPolicy.nextPreviouslyLive(
            current: previouslyLive,
            commit: commit
        )
        if commit.rememberWorkingRoute { rememberedRoute = true }
        if commit.startEndpointRefresh { startedEndpointRefresh = true }
    }

    mutating func applyUnauthorized(startedGeneration: Int, currentGeneration: Int) {
        previouslyLive = StreamTransactionPolicy.nextPreviouslyLiveOnUnauthorized(
            current: previouslyLive,
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
    }
}

/// Stand-in for helper `Session.hydrate`: snapshot generation, fetch, then
/// apply fleet/pins/appearance/catalog only if that generation is current.
/// Helper hydrate does not bump the authoritative revision.
struct HelperHydrateSeam: Equatable {
    var appliedFleet = false
    var persistedPins = false
    var persistedAppearance = false
    var retriedAppearance = false
    var refreshedEngineCatalog = false
    var bumpedRevision = false
    var clearedUnconfirmed = false

    mutating func apply(startedGeneration: Int, currentGeneration: Int) {
        let commit = StreamTransactionPolicy.helperHydrate(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
        if commit.applyFleet { appliedFleet = true }
        if commit.persistPins { persistedPins = true }
        if commit.persistAppearance { persistedAppearance = true }
        if commit.retryAppearance { retriedAppearance = true }
        if commit.refreshEngineCatalog { refreshedEngineCatalog = true }
    }

    mutating func finishUnconfirmed(startedGeneration: Int, currentGeneration: Int) {
        if StreamTransactionPolicy.shouldClearUnconfirmedWrites(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        ) {
            clearedUnconfirmed = true
        }
    }
}

/// Stand-in for `Session.openNotification` fleet hydrate + navigation.
struct NotificationHydrateSeam: Equatable {
    var appliedFleet = false
    var bumpedRevision = false
    var continuedNavigation = false

    mutating func apply(startedGeneration: Int, currentGeneration: Int) {
        let commit = StreamTransactionPolicy.notification(
            startedGeneration: startedGeneration,
            currentGeneration: currentGeneration
        )
        if commit.applyFleet { appliedFleet = true }
        if commit.bumpAuthoritativeRevision { bumpedRevision = true }
        if commit.continueNavigation { continuedNavigation = true }
    }
}

/// Stand-in for appearance PATCH apply + UserDefaults persist.
struct AppearanceRetrySeam: Equatable {
    var appliedBot = false
    var persisted = false

    mutating func applyPatch(
        authority: StreamTransactionPolicy.Authority,
        currentGeneration: Int
    ) {
        guard StreamTransactionPolicy.shouldApplyAppearanceRetry(
            authority: authority,
            currentGeneration: currentGeneration
        ) else { return }
        appliedBot = true
        persisted = true
    }
}
