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

    func testSharedImageIngestionSniffsPNGDespiteJPEGInboxName() {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])
        XCTAssertEqual(ShareStagingPolicy.acceptedSharedImageMIME(for: png), "image/png")
        XCTAssertEqual(ShareStagingPolicy.acceptedShareImageData(png), png)
    }

    func testSharedImageIngestionAcceptsJPEGAndRejectsVideoOrUnknown() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        XCTAssertEqual(ShareStagingPolicy.acceptedSharedImageMIME(for: jpeg), "image/jpeg")

        let mp4 = Data([
            0x00, 0x00, 0x00, 0x18,
            0x66, 0x74, 0x79, 0x70,
            0x69, 0x73, 0x6F, 0x6D,
            0x00, 0x00, 0x00, 0x00,
            0x69, 0x73, 0x6F, 0x6D,
            0x61, 0x76, 0x63, 0x31,
        ])
        XCTAssertNil(ShareStagingPolicy.acceptedSharedImageMIME(for: mp4))
        XCTAssertNil(ShareStagingPolicy.acceptedShareImageData(mp4))
        XCTAssertNil(ShareStagingPolicy.acceptedSharedImageMIME(for: Data([0x00, 0x01, 0x02])))
        XCTAssertNil(ShareStagingPolicy.acceptedShareImageData(Data()))
    }
}
