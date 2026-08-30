import XCTest
@testable import CompanionCore

final class ModelCatalogLoadPolicyTests: XCTestCase {
    func testOverlappingLoadsStayRefreshingUntilTheLastGenerationFinishes() {
        var gate = ModelCatalogRefreshGate()
        let first = gate.beginLoad()
        XCTAssertTrue(gate.refreshing)
        XCTAssertEqual(first, 1)

        let second = gate.beginLoad()
        XCTAssertEqual(second, 2)
        XCTAssertTrue(gate.refreshing)

        XCTAssertFalse(gate.finishLoad(startedGeneration: first))
        XCTAssertTrue(gate.refreshing)
        XCTAssertEqual(gate.generation, 2)

        XCTAssertTrue(gate.finishLoad(startedGeneration: second))
        XCTAssertFalse(gate.refreshing)
        XCTAssertEqual(gate.generation, 2)
    }

    func testStaleCompletionAfterNewerSuccessDoesNotClearOrRestrandRefreshing() {
        var gate = ModelCatalogRefreshGate()
        let first = gate.beginLoad()
        let second = gate.beginLoad()

        XCTAssertTrue(gate.finishLoad(startedGeneration: second))
        XCTAssertFalse(gate.refreshing)

        XCTAssertFalse(gate.finishLoad(startedGeneration: first))
        XCTAssertFalse(gate.refreshing)
    }

    func testCancelledWaiterDoesNotStrandPickerAfterSessionPublish() {
        var gate = ModelCatalogRefreshGate()
        _ = gate.beginLoad()
        _ = gate.beginLoad()

        let stranded = ModelCatalogLoadPolicy.waiterStillLoading(
            resultCancelled: true,
            sessionRefreshing: gate.refreshing
        )
        XCTAssertTrue(stranded)
        XCTAssertTrue(
            ModelCatalogLoadPolicy.hostLoading(
                localLoading: stranded,
                sessionRefreshing: gate.refreshing
            )
        )

        XCTAssertTrue(gate.finishLoad(startedGeneration: gate.generation))
        let local = ModelCatalogLoadPolicy.localLoadingAfterSessionPublish(
            sessionRefreshing: gate.refreshing
        )
        XCTAssertFalse(local)
        XCTAssertFalse(
            ModelCatalogLoadPolicy.hostLoading(
                localLoading: local,
                sessionRefreshing: false
            )
        )
    }

    func testLoadedOrFailedWaiterClearsLocalLoadingEvenIfANewerRefreshStarted() {
        XCTAssertFalse(
            ModelCatalogLoadPolicy.waiterStillLoading(
                resultCancelled: false,
                sessionRefreshing: true
            )
        )
        XCTAssertTrue(
            ModelCatalogLoadPolicy.hostLoading(
                localLoading: false,
                sessionRefreshing: true
            )
        )
    }

    func testWarmCacheIsKeptWhileARefreshIsInFlight() {
        XCTAssertFalse(
            ModelCatalogLoadPolicy.shouldReplaceDisplayedCatalog(
                incomingIsEmpty: true,
                sessionRefreshing: true
            )
        )
        XCTAssertTrue(
            ModelCatalogLoadPolicy.shouldReplaceDisplayedCatalog(
                incomingIsEmpty: false,
                sessionRefreshing: true
            )
        )
        XCTAssertTrue(
            ModelCatalogLoadPolicy.shouldReplaceDisplayedCatalog(
                incomingIsEmpty: true,
                sessionRefreshing: false
            )
        )
    }

    func testRetryStartsANewAuthoritativeGeneration() {
        var gate = ModelCatalogRefreshGate()
        let first = gate.beginLoad()
        XCTAssertTrue(gate.finishLoad(startedGeneration: first))
        XCTAssertFalse(gate.refreshing)

        let retry = gate.beginLoad()
        XCTAssertEqual(retry, 2)
        XCTAssertTrue(gate.refreshing)
        XCTAssertTrue(gate.finishLoad(startedGeneration: retry))
        XCTAssertFalse(gate.refreshing)
    }
}
