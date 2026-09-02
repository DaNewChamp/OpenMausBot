import XCTest
@testable import CompanionCore

private struct ParityFixture: Decodable {
    struct HubCase: Decodable {
        let id: String
        let input: HubInput
        let expected: String
    }

    struct HubInput: Decodable {
        let name: String
        let host: String
        let alias: String?
        let runtimeProfile: String?
    }

    struct FriendlyHostCase: Decodable {
        let id: String
        let host: String
        let expected: String
    }

    struct BridgeCase: Decodable {
        let id: String
        let bridges: [BridgeInput]
        let expectedIds: [String]
        let expectedStale: [Bool]
        let expectedDisplayNames: [String]
    }

    struct BridgeInput: Decodable {
        let id: String
        let name: String
        let hostInfo: String?
        let online: Bool
        let createdAt: Double
        let lastSeenAt: Double
    }

    let hubDisplay: [HubCase]
    let friendlyHost: [FriendlyHostCase]
    let bridgeRoster: [BridgeCase]
}

final class FleetPresentationParityTests: XCTestCase {
    private let fixture: ParityFixture = {
        let url = Bundle.module.url(
            forResource: "fleet-presentation-parity",
            withExtension: "json",
            subdirectory: "Fixtures"
        )!
        let data = try! Data(contentsOf: url)
        return try! JSONDecoder().decode(ParityFixture.self, from: data)
    }()

    func testHubDisplayParityMatrix() {
        for row in fixture.hubDisplay {
            let actual = FleetPresentationPolicy.resolveHubDisplayName(
                name: row.input.name,
                host: row.input.host,
                alias: row.input.alias,
                runtimeProfile: row.input.runtimeProfile
            )
            XCTAssertEqual(actual, row.expected, "hub case \(row.id)")
        }
    }

    func testFriendlyHostParityMatrix() {
        for row in fixture.friendlyHost {
            XCTAssertEqual(
                FleetPresentationPolicy.friendlyNameFromHost(row.host),
                row.expected,
                "friendly host case \(row.id)"
            )
        }
    }

    func testBridgeRosterParityMatrix() {
        for row in fixture.bridgeRoster {
            let bridges = row.bridges.map { bridge in
                BridgeRosterEntry(
                    id: bridge.id,
                    name: bridge.name,
                    capabilities: [],
                    grantedCapabilities: [],
                    createdAt: bridge.createdAt,
                    lastSeenAt: bridge.lastSeenAt,
                    hostInfo: bridge.hostInfo,
                    online: bridge.online
                )
            }
            let presented = BridgePresentationPolicy.present(bridges)
            XCTAssertEqual(presented.map(\.id), row.expectedIds, "bridge ids for \(row.id)")
            XCTAssertEqual(presented.map(\.stale), row.expectedStale, "stale flags for \(row.id)")
            XCTAssertEqual(presented.map(\.displayName), row.expectedDisplayNames, "names for \(row.id)")
        }
    }
}

final class BridgeAccessibilityTests: XCTestCase {
    func testBridgeRowAccessibilityLabelIncludesNameRoleAndState() {
        let entry = BridgeRosterEntry(
            id: "br-mini",
            name: "mini",
            capabilities: ["shell"],
            grantedCapabilities: ["shell"],
            createdAt: 1,
            lastSeenAt: 2,
            hostInfo: "macmini.local",
            online: false
        )
        let bridge = PresentedBridgeEntry(
            entry: entry,
            displayName: "Mac mini",
            roleLabel: .previousRegistration,
            stale: true
        )
        XCTAssertEqual(
            BridgePresentationPolicy.accessibilityLabel(for: bridge),
            "Mac mini, Previous registration, Offline"
        )
    }
}
