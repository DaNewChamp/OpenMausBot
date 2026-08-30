import XCTest
@testable import CompanionCore

final class ShareStagingPolicyTests: XCTestCase {
    func testTakeAbsorbsOnceAndClearsFields() {
        var staging = ShareStaging(text: "from safari", imageData: Data([1, 2, 3]))
        let first = staging.take()
        XCTAssertEqual(first.text, "from safari")
        XCTAssertEqual(first.imageData, Data([1, 2, 3]))
        XCTAssertTrue(staging.isEmpty)

        let second = staging.take()
        XCTAssertTrue(second.isEmpty)
        XCTAssertTrue(staging.isEmpty)
    }

    func testMergingStagedTextMatchesComposerAbsorbRules() {
        XCTAssertEqual(ShareStagingPolicy.merging("hello", into: ""), "hello")
        XCTAssertEqual(ShareStagingPolicy.merging("more", into: "hello "), "hello more")
        XCTAssertEqual(ShareStagingPolicy.merging("more", into: "hello"), "hello more")
        XCTAssertEqual(ShareStagingPolicy.merging("  ", into: "keep"), "keep")
    }

    func testDiscardClearsTextAndImage() {
        var staging = ShareStaging(text: "kept by cancel", imageData: Data([9]))
        staging.discard()
        XCTAssertTrue(staging.isEmpty)
    }
}
