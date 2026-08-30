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
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    func testClearPendingRemovesPayloadWithoutConsumingIntoApp() throws {
        try ShareInbox.save(text: "draft", imageData: Data([1, 2, 3]))
        ShareInbox.clearPending()
        XCTAssertFalse(ShareInbox.hasPending())
        XCTAssertNil(ShareInbox.consume())
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    func testSecondSaveReplacesFirstPayload() throws {
        try ShareInbox.save(text: "first")
        try ShareInbox.save(url: "https://replaced.test")
        let consumed = try XCTUnwrap(ShareInbox.consume())
        XCTAssertNil(consumed.payload.text)
        XCTAssertEqual(consumed.payload.url, "https://replaced.test")
    }

    func testSecondSaveRemovesPriorImageFile() throws {
        try ShareInbox.save(text: "photo", imageData: Data([0xFF, 0xD8, 0xFF, 0xD9]))
        XCTAssertEqual(inboxJPEGNames().count, 1)
        try ShareInbox.save(url: "https://replaced.test")
        XCTAssertEqual(inboxJPEGNames(), [])
        let consumed = try XCTUnwrap(ShareInbox.consume())
        XCTAssertNil(consumed.payload.text)
        XCTAssertNil(consumed.imageData)
        XCTAssertEqual(consumed.payload.url, "https://replaced.test")
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    func testConsumeIgnoresNonUUIDImageFilename() throws {
        let payload = ShareInbox.Payload(text: "hi", imageFilename: "../secret.jpg")
        let data = try JSONEncoder().encode(payload)
        UserDefaults(suiteName: ShareInbox.testDefaultsSuite!)!.set(data, forKey: ShareInbox.payloadKey)
        let outside = testRoot.deletingLastPathComponent().appendingPathComponent("secret.jpg")
        try Data([9]).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }

        let consumed = try XCTUnwrap(ShareInbox.consume())
        XCTAssertEqual(consumed.payload.text, "hi")
        XCTAssertNil(consumed.imageData)
        XCTAssertEqual(try Data(contentsOf: outside), Data([9]))
    }

    func testValidImageFilenameAcceptsUUIDJpegOnly() {
        XCTAssertTrue(ShareInbox.isValidImageFilename("E621E1F8-C36C-495A-93FC-0C247A3E6E5F.jpg"))
        XCTAssertFalse(ShareInbox.isValidImageFilename("../secret.jpg"))
        XCTAssertFalse(ShareInbox.isValidImageFilename("folder/uuid.jpg"))
        XCTAssertFalse(ShareInbox.isValidImageFilename("not-a-uuid.jpg"))
        XCTAssertFalse(ShareInbox.isValidImageFilename("E621E1F8-C36C-495A-93FC-0C247A3E6E5F.png"))
    }

    func testConcurrentSavesLeaveAtMostOneImageFile() throws {
        let group = DispatchGroup()
        for byte in 0..<8 {
            group.enter()
            DispatchQueue.global().async {
                try? ShareInbox.save(imageData: Data([UInt8(byte), 0xD8, 0xFF, 0xD9]))
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 5), .success)
        XCTAssertLessThanOrEqual(inboxJPEGNames().count, 1)
        _ = ShareInbox.consume()
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    private func inboxJPEGNames() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: testRoot.path))?
            .filter { $0.lowercased().hasSuffix(".jpg") }
            .sorted() ?? []
    }
}
