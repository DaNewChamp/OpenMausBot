import XCTest
@testable import CompanionCore

final class ScreenWatchRegistryTests: XCTestCase {
    func testFirstCloseForSameBotRetainsItsWatcherAndFrame() {
        var registry = ScreenWatchRegistry()
        XCTAssertTrue(registry.start(botId: "chief"))
        XCTAssertFalse(registry.start(botId: "chief"))

        let result = registry.stop(botId: "chief")

        XCTAssertTrue(result.stopped)
        XCTAssertFalse(result.lastForBot)
        XCTAssertFalse(result.lastOverall)
        XCTAssertEqual(result.remainingForBot, 1)
        XCTAssertEqual(registry.count(for: "chief"), 1)
        XCTAssertEqual(registry.totalCount, 1)
    }

    func testLastCloseForBotClearsThatBotAndDisablesSharedStreamWhenAlone() {
        var registry = ScreenWatchRegistry()
        registry.start(botId: "chief")
        registry.start(botId: "chief")
        _ = registry.stop(botId: "chief")

        let result = registry.stop(botId: "chief")

        XCTAssertTrue(result.stopped)
        XCTAssertTrue(result.lastForBot)
        XCTAssertTrue(result.lastOverall)
        XCTAssertEqual(result.remainingForBot, 0)
        XCTAssertFalse(registry.isWatching(botId: "chief"))
        XCTAssertEqual(registry.totalCount, 0)
    }

    func testLastCloseForBotDoesNotDisableAnotherBotStream() {
        var registry = ScreenWatchRegistry()
        registry.start(botId: "chief")
        registry.start(botId: "risk")

        let result = registry.stop(botId: "chief")

        XCTAssertTrue(result.lastForBot)
        XCTAssertFalse(result.lastOverall)
        XCTAssertEqual(registry.count(for: "risk"), 1)
        XCTAssertEqual(registry.totalCount, 1)
    }

    func testUnmatchedCloseIsHarmless() {
        var registry = ScreenWatchRegistry()

        let result = registry.stop(botId: "missing")

        XCTAssertFalse(result.stopped)
        XCTAssertFalse(result.lastForBot)
        XCTAssertFalse(result.lastOverall)
        XCTAssertEqual(registry.totalCount, 0)
    }
}
