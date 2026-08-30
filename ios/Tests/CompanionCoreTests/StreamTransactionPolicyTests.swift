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
