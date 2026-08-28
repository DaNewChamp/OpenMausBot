import XCTest
@testable import CompanionCore

final class RosterPreviewTests: XCTestCase {
    func testStripsMarkdownHeadings() {
        XCTAssertEqual(
            ConversationSummary.rosterPreview("## Rakazo Relay implementation report\nNext steps"),
            "Rakazo Relay implementation report Next steps"
        )
    }

    func testStripsQuotePrefix() {
        XCTAssertEqual(
            ConversationSummary.rosterPreview("> Coder: hello\n\nGot it"),
            "Coder: hello Got it"
        )
    }

    func testLeavesPlainProse() {
        XCTAssertEqual(
            ConversationSummary.rosterPreview("Yesterday’s 84-85 is off the book (wipe)."),
            "Yesterday’s 84-85 is off the book (wipe)."
        )
    }
}
