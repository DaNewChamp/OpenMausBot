import XCTest
@testable import CompanionCore

final class ShareInboxTests: XCTestCase {
    private var testRoot: URL!

    override func setUp() {
        super.setUp()
        testRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("share-inbox-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: testRoot, withIntermediateDirectories: true)
        ShareInbox.testRootURL = testRoot
        ShareInbox.testDefaultsSuite = "ShareInboxTests.\(UUID().uuidString)"
        ShareInbox.clearPending()
    }

    override func tearDown() {
        ShareInbox.clearPending()
        ShareInbox.testRootURL = nil
        ShareInbox.testDefaultsSuite = nil
        try? FileManager.default.removeItem(at: testRoot)
        super.tearDown()
    }

    func testSaveAndConsumeClearsPendingPayloadAndImageFile() throws {
        let image = Data([0xFF, 0xD8, 0xFF, 0xD9])
        try ShareInbox.save(text: "hello", url: "https://example.com", imageData: image)

        XCTAssertTrue(ShareInbox.hasPending())

        let consumed = try XCTUnwrap(ShareInbox.consume())
        XCTAssertEqual(consumed.payload.text, "hello")
        XCTAssertEqual(consumed.payload.url, "https://example.com")
        XCTAssertEqual(consumed.imageData, image)
        XCTAssertFalse(ShareInbox.hasPending())
        XCTAssertNil(ShareInbox.consume())
        XCTAssertTrue((try? FileManager.default.contentsOfDirectory(atPath: testRoot.path))?.isEmpty == true)
    }

    func testClearPendingRemovesPayloadWithoutConsumingIntoApp() throws {
        try ShareInbox.save(text: "draft", imageData: Data([1, 2, 3]))
        ShareInbox.clearPending()
        XCTAssertFalse(ShareInbox.hasPending())
        XCTAssertNil(ShareInbox.consume())
        XCTAssertTrue((try? FileManager.default.contentsOfDirectory(atPath: testRoot.path))?.isEmpty == true)
    }

    func testSecondSaveReplacesFirstPayload() throws {
        try ShareInbox.save(text: "first")
        try ShareInbox.save(url: "https://replaced.test")
        let consumed = try XCTUnwrap(ShareInbox.consume())
        XCTAssertNil(consumed.payload.text)
        XCTAssertEqual(consumed.payload.url, "https://replaced.test")
    }
}
