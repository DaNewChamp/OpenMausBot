import XCTest
@testable import CompanionCore

final class PhotoLibrarySavePolicyTests: XCTestCase {
    func testAddOnlyCopyMatchesTheUsageDescription() {
        XCTAssertEqual(
            PhotoLibrarySavePolicy.addUsageDescription,
            "V Bot saves desktop screenshots to your photo library when you tap Save."
        )
    }

    func testDeniedOffersSettingsAndDoesNotClaimSaved() {
        XCTAssertEqual(
            PhotoLibrarySavePolicy.outcome(authorization: .denied, saved: true),
            .denied
        )
        XCTAssertEqual(
            PhotoLibrarySavePolicy.outcome(authorization: .restricted, saved: false),
            .denied
        )
        XCTAssertTrue(PhotoLibrarySavePolicy.offersSettingsLink(for: .denied))
        XCTAssertEqual(PhotoLibrarySavePolicy.message(for: .denied), PhotoLibrarySavePolicy.deniedMessage)
        XCTAssertTrue(PhotoLibrarySavePolicy.deniedMessage.contains("Settings"))
        XCTAssertEqual(PhotoLibrarySavePolicy.settingsActionTitle, "Open Settings")
    }

    func testAuthorizedSaveAndFailure() {
        XCTAssertEqual(PhotoLibrarySavePolicy.outcome(authorization: .authorized, saved: true), .saved)
        XCTAssertEqual(PhotoLibrarySavePolicy.outcome(authorization: .authorized, saved: false), .failed)
        XCTAssertEqual(PhotoLibrarySavePolicy.outcome(authorization: .undetermined, saved: false), .failed)
        XCTAssertFalse(PhotoLibrarySavePolicy.offersSettingsLink(for: .saved))
        XCTAssertFalse(PhotoLibrarySavePolicy.offersSettingsLink(for: .failed))
        XCTAssertEqual(PhotoLibrarySavePolicy.message(for: .saved), "Saved")
        XCTAssertEqual(PhotoLibrarySavePolicy.message(for: .failed), PhotoLibrarySavePolicy.failedMessage)
    }
}
