import Darwin
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
        ShareInbox.testForceLockUnavailable = false
        ShareInbox.testAppGroupAvailable = nil
        ShareInbox.testStorePreviewActive = nil
        ShareInbox.testStorePreviewRootURL = nil
        ShareInbox.testStorePreviewDefaultsSuite = nil
        try? ShareInbox.clearPending()
    }

    override func tearDown() {
        ShareInbox.testForceLockUnavailable = false
        try? ShareInbox.clearPending()
        ShareInbox.testRootURL = nil
        ShareInbox.testDefaultsSuite = nil
        ShareInbox.testAppGroupAvailable = nil
        ShareInbox.testStorePreviewActive = nil
        ShareInbox.testStorePreviewRootURL = nil
        ShareInbox.testStorePreviewDefaultsSuite = nil
        try? FileManager.default.removeItem(at: testRoot)
        super.tearDown()
    }

    func testSaveAndConsumeClearsPendingPayloadAndImageFile() throws {
        let image = Data([0xFF, 0xD8, 0xFF, 0xD9])
        try ShareInbox.save(text: "hello", url: "https://example.com", imageData: image)

        XCTAssertTrue(try ShareInbox.hasPending())

        let consumed = try XCTUnwrap(try ShareInbox.consume())
        XCTAssertEqual(consumed.payload.text, "hello")
        XCTAssertEqual(consumed.payload.url, "https://example.com")
        XCTAssertEqual(consumed.imageData, image)
        XCTAssertFalse(try ShareInbox.hasPending())
        XCTAssertNil(try ShareInbox.consume())
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    func testClearPendingRemovesPayloadWithoutConsumingIntoApp() throws {
        try ShareInbox.save(text: "draft", imageData: Data([1, 2, 3]))
        try ShareInbox.clearPending()
        XCTAssertFalse(try ShareInbox.hasPending())
        XCTAssertNil(try ShareInbox.consume())
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    func testSecondSaveReplacesFirstPayload() throws {
        try ShareInbox.save(text: "first")
        try ShareInbox.save(url: "https://replaced.test")
        let consumed = try XCTUnwrap(try ShareInbox.consume())
        XCTAssertNil(consumed.payload.text)
        XCTAssertEqual(consumed.payload.url, "https://replaced.test")
    }

    func testSecondSaveRemovesPriorImageFile() throws {
        try ShareInbox.save(text: "photo", imageData: Data([0xFF, 0xD8, 0xFF, 0xD9]))
        XCTAssertEqual(inboxJPEGNames().count, 1)
        try ShareInbox.save(url: "https://replaced.test")
        XCTAssertEqual(inboxJPEGNames(), [])
        let consumed = try XCTUnwrap(try ShareInbox.consume())
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

        let consumed = try XCTUnwrap(try ShareInbox.consume())
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
        _ = try ShareInbox.consume()
        XCTAssertEqual(inboxJPEGNames(), [])
    }

    func testSaveThrowsWhenLockUnavailableFlagSet() {
        ShareInbox.testForceLockUnavailable = true
        XCTAssertThrowsError(try ShareInbox.save(text: "blocked")) { error in
            XCTAssertEqual(error as? ShareInboxError, .lockUnavailable)
        }
    }

    func testSaveThrowsWhenCrossProcessLockHeld() throws {
        let lockURL = testRoot.appendingPathComponent(".share-inbox.lock")
        FileManager.default.createFile(atPath: lockURL.path, contents: nil)
        let fd = open(lockURL.path, O_RDWR)
        XCTAssertGreaterThanOrEqual(fd, 0)
        XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
        defer {
            flock(fd, LOCK_UN)
            close(fd)
        }

        XCTAssertThrowsError(try ShareInbox.save(text: "blocked")) { error in
            XCTAssertEqual(error as? ShareInboxError, .lockUnavailable)
        }
    }

    func testUnavailableAppGroupFailsClosedOutsideStorePreview() {
        ShareInbox.testRootURL = nil
        ShareInbox.testDefaultsSuite = nil
        ShareInbox.testAppGroupAvailable = false
        ShareInbox.testStorePreviewActive = false
        XCTAssertThrowsError(try ShareInbox.save(text: "nope")) { error in
            XCTAssertEqual(error as? ShareInboxError, .appGroupUnavailable)
        }
        XCTAssertThrowsError(try ShareInbox.hasPending()) { error in
            XCTAssertEqual(error as? ShareInboxError, .appGroupUnavailable)
        }
        XCTAssertThrowsError(try ShareInbox.consume()) { error in
            XCTAssertEqual(error as? ShareInboxError, .appGroupUnavailable)
        }
    }

    func testStorePreviewInboxIsIsolatedWhenAppGroupMissing() throws {
        ShareInbox.testRootURL = nil
        ShareInbox.testDefaultsSuite = nil
        ShareInbox.testAppGroupAvailable = false
        ShareInbox.testStorePreviewActive = true
        let previewRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("store-preview-inbox-\(UUID().uuidString)", isDirectory: true)
        ShareInbox.testStorePreviewRootURL = previewRoot
        ShareInbox.testStorePreviewDefaultsSuite = "ShareInboxPreviewTests.\(UUID().uuidString)"
        defer {
            try? ShareInbox.clearPending()
            try? FileManager.default.removeItem(at: previewRoot)
        }

        try ShareInbox.save(text: "preview-only")
        XCTAssertTrue(FileManager.default.fileExists(atPath: previewRoot.path))
        XCTAssertFalse(previewRoot.path.contains(ShareInbox.appGroup))
        let consumed = try XCTUnwrap(try ShareInbox.consume())
        XCTAssertEqual(consumed.payload.text, "preview-only")
        XCTAssertNil(try ShareInbox.consume())
    }

    func testStorePreviewFlagDoesNotRedirectWhenTestContainerExists() throws {
        let previewRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("unused-preview-\(UUID().uuidString)", isDirectory: true)
        ShareInbox.testStorePreviewRootURL = previewRoot
        ShareInbox.testStorePreviewActive = true
        ShareInbox.testAppGroupAvailable = false
        try ShareInbox.save(text: "stays-in-test-root")
        XCTAssertFalse(FileManager.default.fileExists(atPath: previewRoot.path))
        let consumed = try XCTUnwrap(try ShareInbox.consume())
        XCTAssertEqual(consumed.payload.text, "stays-in-test-root")
    }

    private func inboxJPEGNames() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: testRoot.path))?
            .filter { $0.lowercased().hasSuffix(".jpg") }
            .sorted() ?? []
    }
}
