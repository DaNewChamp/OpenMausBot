import XCTest
@testable import CompanionCore

final class ProductIdentityTests: XCTestCase {
    func testDisplayNameIsVBot() {
        XCTAssertEqual(ProductIdentity.displayName, "V Bot")
        XCTAssertFalse(ProductIdentity.displayName.contains("OpenMaus"))
        XCTAssertFalse(ProductIdentity.displayName.localizedCaseInsensitiveContains("grok"))
        XCTAssertFalse(ProductIdentity.displayName.localizedCaseInsensitiveContains("xai"))
    }

    func testUserFacingRouteCopyNamesVBotNotTheLegacyMobileLabel() {
        let unreachable = PairingRouteError(attemptedHosts: ["mac.local"]).errorDescription ?? ""
        XCTAssertTrue(unreachable.contains(ProductIdentity.displayName))
        XCTAssertFalse(unreachable.contains("OpenMausMobile"))

        let advice = ConnectionAdvice.message(
            for: .cannotConnectToHost,
            host: "mac.local",
            port: 8810
        )
        XCTAssertTrue(advice.contains(ProductIdentity.displayName))
        XCTAssertFalse(advice.contains("OpenMausMobile"))
    }
}
