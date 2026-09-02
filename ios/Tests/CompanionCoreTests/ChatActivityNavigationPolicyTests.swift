import XCTest
@testable import CompanionCore

final class ChatActivityNavigationPolicyTests: XCTestCase {
    func testHomeRowsOpenThroughRosterNavigation() {
        XCTAssertEqual(
            ChatActivityNavigationPolicy.action(fromParentThreadId: nil),
            .openFromHome
        )
    }

    func testInChatRowsPushFocusedTranscript() {
        XCTAssertEqual(
            ChatActivityNavigationPolicy.action(fromParentThreadId: "parent-thread"),
            .pushFocusedTranscript
        )
    }
}
