import XCTest
@testable import CompanionCore

final class ShareExtensionOpenCoordinatorTests: XCTestCase {
    func testCompletesOnceWhenOpenSucceeds() {
        let queue = DispatchQueue(label: "share-open-success")
        let done = expectation(description: "complete")
        done.expectedFulfillmentCount = 1
        let coordinator = ShareExtensionOpenCoordinator(
            timeout: 1.0,
            queue: queue,
            open: { completion in
                completion(true)
            },
            complete: { done.fulfill() }
        )
        coordinator.start()
        wait(for: [done], timeout: 1.0)
    }

    func testCompletesOnceWhenOpenNeverCallsBack() {
        let queue = DispatchQueue(label: "share-open-timeout")
        let done = expectation(description: "complete")
        done.expectedFulfillmentCount = 1
        let coordinator = ShareExtensionOpenCoordinator(
            timeout: 0.05,
            queue: queue,
            open: { _ in },
            complete: { done.fulfill() }
        )
        coordinator.start()
        wait(for: [done], timeout: 1.0)
    }

    func testCompletesOnceWhenOpenAndTimeoutRace() {
        let queue = DispatchQueue(label: "share-open-race")
        let done = expectation(description: "complete")
        done.expectedFulfillmentCount = 1
        let coordinator = ShareExtensionOpenCoordinator(
            timeout: 0.05,
            queue: queue,
            open: { completion in
                queue.asyncAfter(deadline: .now() + 0.1) {
                    completion(true)
                }
            },
            complete: { done.fulfill() }
        )
        coordinator.start()
        wait(for: [done], timeout: 1.0)
    }
}
