import XCTest
@testable import CompanionCore

final class AccountAvatarPhotoStoreTests: XCTestCase {
    private var support: URL!
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        support = FileManager.default.temporaryDirectory
            .appendingPathComponent("AccountAvatarPhotoStoreTests.\(UUID().uuidString)", isDirectory: true)
        suiteName = "AccountAvatarPhotoStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        AccountAvatarPhotoStore.testSupportDirectory = support
        AccountAvatarPhotoStore.testDefaults = defaults
    }

    override func tearDown() {
        AccountAvatarPhotoStore.testSupportDirectory = nil
        AccountAvatarPhotoStore.testDefaults = nil
        defaults.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: support)
        super.tearDown()
    }

    func testMissingPhotoIsUnavailableAndFallsBack() {
        XCTAssertNil(AccountAvatarPhotoStore.loadPhoto())
        XCTAssertFalse(AccountAvatarPhotoStore.isAvailable())
        XCTAssertEqual(AccountAvatarPhotoStore.revision(), 0)
        XCTAssertEqual(AccountAvatarPhotoStore.fileProtectionPolicy, .completeUntilFirstUserAuthentication)
    }

    func testSavedPhotoLivesOnDiskWithARevisionMarkerNotInDefaults() throws {
        let jpeg = try AvatarImageFixtures.stillJPEG(width: 8, height: 8)
        try AccountAvatarPhotoStore.savePhoto(jpeg)

        XCTAssertEqual(AccountAvatarPhotoStore.revision(), 1)
        XCTAssertTrue(AccountAvatarPhotoStore.isAvailable())
        XCTAssertEqual(AccountAvatarPhotoStore.loadPhoto(), jpeg)
        XCTAssertNil(defaults.data(forKey: AccountAvatarPhotoStore.revisionDefaultsKey))
        XCTAssertEqual(defaults.integer(forKey: AccountAvatarPhotoStore.revisionDefaultsKey), 1)
        assertDefaultsContainNoImageBytes()
        XCTAssertEqual(AccountAvatarPhotoStore.fileName, "account-avatar.jpg")
        XCTAssertFalse(defaults.string(forKey: AccountAvatarPhotoStore.revisionDefaultsKey)?.contains("/") == true)
    }

    func testCorruptOrUnreadableFileIsUnavailable() throws {
        let jpeg = try AvatarImageFixtures.stillJPEG(width: 8, height: 8)
        try AccountAvatarPhotoStore.savePhoto(jpeg)
        let url = AccountAvatarPhotoStore.photoURL()
        try Data([0x00, 0x01, 0x02, 0x03]).write(to: url, options: .atomic)

        XCTAssertNil(AccountAvatarPhotoStore.loadPhoto())
        XCTAssertFalse(AccountAvatarPhotoStore.isAvailable())
        XCTAssertEqual(AccountAvatarPhotoStore.revision(), 1)
    }

    func testTruncatedJPEGIsUnavailable() throws {
        let jpeg = try AvatarImageFixtures.stillJPEG(width: 32, height: 32)
        try AccountAvatarPhotoStore.savePhoto(jpeg)
        try Data(jpeg.prefix(12)).write(to: AccountAvatarPhotoStore.photoURL(), options: .atomic)
        XCTAssertNil(AccountAvatarPhotoStore.loadPhoto())
        XCTAssertFalse(AccountAvatarPhotoStore.isAvailable())
    }

    func testRemoveClearsTheFileAndRevisionMarker() throws {
        try AccountAvatarPhotoStore.savePhoto(try AvatarImageFixtures.stillJPEG(width: 8, height: 8))
        try AccountAvatarPhotoStore.removePhoto()
        XCTAssertNil(AccountAvatarPhotoStore.loadPhoto())
        XCTAssertFalse(AccountAvatarPhotoStore.isAvailable())
        XCTAssertEqual(AccountAvatarPhotoStore.revision(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: AccountAvatarPhotoStore.photoURL().path))
    }

    func testCancelLeavesThePersistedPhotoUntouched() throws {
        let jpeg = try AvatarImageFixtures.stillJPEG(width: 8, height: 8)
        try AccountAvatarPhotoStore.savePhoto(jpeg)
        let before = AccountAvatarPhotoStore.Snapshot(
            revision: AccountAvatarPhotoStore.revision(),
            photo: AccountAvatarPhotoStore.loadPhoto()
        )
        let afterCancel = AvatarPhotoPresentation.afterCancel(
            AvatarPhotoPresentation.Snapshot(revision: before.revision, photoPresent: before.photo != nil)
        )
        XCTAssertEqual(afterCancel.revision, before.revision)
        XCTAssertEqual(afterCancel.photoPresent, true)
        XCTAssertEqual(AccountAvatarPhotoStore.loadPhoto(), jpeg)
        XCTAssertEqual(AccountAvatarPhotoStore.revision(), before.revision)
    }

    private func assertDefaultsContainNoImageBytes() {
        XCTAssertNil(defaults.data(forKey: AccountAvatarPhotoStore.revisionDefaultsKey))
        XCTAssertEqual(defaults.integer(forKey: AccountAvatarPhotoStore.revisionDefaultsKey), 1)
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("companion.prefs.") {
            if let data = defaults.data(forKey: key) {
                XCTAssertLessThan(data.count, 32, "UserDefaults \(key) stored image bytes")
                XCTAssertFalse(AvatarCropExport.isJPEG(data), "UserDefaults \(key) stored a JPEG")
            }
            if let text = defaults.string(forKey: key) {
                XCTAssertFalse(text.contains("base64"), "UserDefaults \(key) stored base64")
                XCTAssertLessThan(text.count, 64, "UserDefaults \(key) stored a large string")
            }
        }
    }
}
