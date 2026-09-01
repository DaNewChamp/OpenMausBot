import XCTest
@testable import CompanionCore

final class AccountPresentationPolicyTests: XCTestCase {
    func testAccountAvatarRejectsUnknownStoredSymbols() {
        XCTAssertEqual(AccountAvatarSymbol.normalized("crown.fill"), "crown.fill")
        XCTAssertEqual(AccountAvatarSymbol.normalized("not.a.real.choice"), "person.fill")
    }

    func testGenericProductNameFallsBackToComputerHost() {
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "OpenMausBot", host: "Vincents-Mac-mini.local"),
            "Vincents Mac mini"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "V Bot", host: "macbook.lan"),
            "MacBook"
        )
    }

    func testCustomComputerNameIsPreserved() {
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "Studio Mac", host: "macmini.local"),
            "Studio Mac"
        )
    }

    func testSavedAliasOverridesGenericServerName() {
        let connection = Connection(
            id: "home",
            name: "OpenMausBot",
            host: "macmini.local",
            port: 8810,
            alias: "Home Mac"
        )
        XCTAssertEqual(ConnectionPresentationPolicy.displayName(for: connection), "Home Mac")
    }

    func testOpenMausIsTreatedAsGeneric() {
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "OpenMaus", host: "studio-mac.local"),
            "Studio Mac"
        )
    }

    func testGenericNameDoesNotTurnAnAddressIntoAComputerName() {
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "OpenMausBot", host: "192.168.112.112"),
            "Connected computer"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "V Bot", host: "fd00::1234"),
            "Connected computer"
        )
    }

    func testFleetSummaryDescribesPhonePairings() {
        XCTAssertEqual(ConnectionPresentationPolicy.fleetSummary(count: 0), "No computers paired")
        XCTAssertEqual(ConnectionPresentationPolicy.fleetSummary(count: 1), "1 computer paired")
        XCTAssertEqual(ConnectionPresentationPolicy.fleetSummary(count: 3), "3 computers paired")
    }
}
