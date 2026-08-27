import XCTest
@testable import CompanionCore

final class ConversationTextSizeTests: XCTestCase {
    func testConversationTextSizeUsesBoundedScales() {
        XCTAssertEqual(ConversationTextSize.small.scale, 0.9)
        XCTAssertEqual(ConversationTextSize.standard.scale, 1.0)
        XCTAssertEqual(ConversationTextSize.large.scale, 1.15)
        XCTAssertEqual(ConversationTextSize(rawValue: "future") ?? .standard, .standard)
        XCTAssertLessThan(ConversationTextSize.small.scale, ConversationTextSize.standard.scale)
        XCTAssertLessThan(ConversationTextSize.standard.scale, ConversationTextSize.large.scale)
        XCTAssertEqual(ConversationTextSize.allCases.count, 3)
    }
}
