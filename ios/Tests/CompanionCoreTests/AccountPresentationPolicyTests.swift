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
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(name: "OpenMausBot", host: ""),
            "Connected computer"
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

    func testRuntimeProfileOnConnectionDrivesHeadlessLabel() {
        let connection = Connection(
            id: "headless",
            name: "OpenMausBot",
            host: "192.168.112.112",
            port: 8810,
            runtimeProfile: "headless-hub"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(for: connection),
            "Headless V Bot hub"
        )
    }

    func testSavedConnectionWithoutRuntimeProfileStillDecodes() throws {
        let data = Data(
            #"{"id":"legacy","name":"OpenMausBot","host":"macmini.local","port":8810}"#.utf8
        )
        let connection = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertNil(connection.runtimeProfile)
        XCTAssertEqual(
            ConnectionPresentationPolicy.displayName(for: connection),
            "Mac mini"
        )
    }

    func testFleetSummaryDescribesPhonePairings() {
        XCTAssertEqual(ConnectionPresentationPolicy.fleetSummary(count: 0), "No computers paired")
        XCTAssertEqual(ConnectionPresentationPolicy.fleetSummary(count: 1), "1 computer paired")
        XCTAssertEqual(ConnectionPresentationPolicy.fleetSummary(count: 3), "3 computers paired")
    }

    func testComputerSummaryFormatsHubAndConnectedComputers() {
        XCTAssertEqual(
            ConnectionPresentationPolicy.computerSummary(hubCount: 1, connectedComputerCount: 2),
            "1 hub · 2 connected computers"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.computerSummary(hubCount: 1, connectedComputerCount: 1),
            "1 hub · 1 connected computer"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.computerSummary(hubCount: 1, connectedComputerCount: 0),
            "1 hub · 0 connected computers"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.computerSummary(hubCount: 0, connectedComputerCount: 0),
            "0 hubs · 0 connected computers"
        )
        XCTAssertEqual(
            ConnectionPresentationPolicy.computerSummary(hubCount: 2, connectedComputerCount: 3),
            "2 hubs · 3 connected computers"
        )
    }

    func testSectionTitlesUseHubAndAvailableComputers() {
        XCTAssertEqual(ConnectionPresentationPolicy.hubSectionTitle, "Hub")
        XCTAssertEqual(ConnectionPresentationPolicy.bridgeSectionTitle, "Available computers")
        XCTAssertEqual(ConnectionPresentationPolicy.availableComputersSectionTitle, "Available computers")
        XCTAssertFalse(ConnectionPresentationPolicy.bridgeSectionTitle.contains("Execution bridge"))
    }
}

