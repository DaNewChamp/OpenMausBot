import XCTest
@testable import CompanionCore

final class FleetPresentationPolicyTests: XCTestCase {
    func testGenericHubNamesIncludeLegacyOpenMausLabels() {
        XCTAssertTrue(FleetPresentationPolicy.isGenericHubName("OpenMausBot"))
        XCTAssertTrue(FleetPresentationPolicy.isGenericHubName("OpenMaus"))
        XCTAssertFalse(FleetPresentationPolicy.isGenericHubName("Studio Mac"))
    }

    func testHeadlessProfileFallbackUsesRuntimeProfileNotAddress() {
        XCTAssertEqual(
            FleetPresentationPolicy.resolveHubDisplayName(
                name: "OpenMausBot",
                host: "192.168.112.112",
                runtimeProfile: "headless-hub"
            ),
            "Headless V Bot hub"
        )
    }
}

final class BridgePresentationPolicyTests: XCTestCase {
    func testStaleBridgeWithMatchingHostIdentityIsLabeledNotMergedByName() {
        let presented = BridgePresentationPolicy.present([
            BridgeRosterEntry(
                id: "br-old",
                name: "mini",
                capabilities: ["shell"],
                grantedCapabilities: ["shell"],
                createdAt: 1,
                lastSeenAt: 2,
                hostInfo: "macmini.local",
                online: false
            ),
            BridgeRosterEntry(
                id: "br-new",
                name: "mini",
                capabilities: ["shell"],
                grantedCapabilities: ["shell"],
                createdAt: 10,
                lastSeenAt: 20,
                hostInfo: "macmini.local",
                online: true
            ),
        ])

        XCTAssertEqual(presented.map(\.id), ["br-new", "br-old"])
        XCTAssertEqual(presented[0].roleLabel, .connectedBridge)
        XCTAssertEqual(presented[1].roleLabel, .previousRegistration)
        XCTAssertTrue(presented[1].stale)
    }

    func testSameDisplayNameOnDifferentHostsStaysSeparate() {
        let presented = BridgePresentationPolicy.present([
            BridgeRosterEntry(
                id: "br-a",
                name: "mini",
                capabilities: [],
                grantedCapabilities: [],
                createdAt: 1,
                lastSeenAt: 2,
                hostInfo: "macmini.local",
                online: true
            ),
            BridgeRosterEntry(
                id: "br-b",
                name: "mini",
                capabilities: [],
                grantedCapabilities: [],
                createdAt: 3,
                lastSeenAt: 4,
                hostInfo: "other-mac.local",
                online: false
            ),
        ])

        XCTAssertEqual(presented.count, 2)
        XCTAssertFalse(presented.contains(where: \.stale))
    }

    func testGenericBridgeNameFallsBackToHostEvidence() {
        let presented = BridgePresentationPolicy.present([
            BridgeRosterEntry(
                id: "br-mini",
                name: "OpenMausBot",
                capabilities: [],
                grantedCapabilities: [],
                createdAt: 1,
                lastSeenAt: 2,
                hostInfo: "macmini.local",
                online: true
            ),
        ])

        XCTAssertEqual(presented.first?.displayName, "Mac mini")
    }

    func testGenericBridgeWithoutHostInfoUsesConnectedBridge() {
        let presented = BridgePresentationPolicy.present([
            BridgeRosterEntry(
                id: "br-generic",
                name: "OpenMausBot",
                capabilities: [],
                grantedCapabilities: [],
                createdAt: 1,
                lastSeenAt: 2,
                hostInfo: nil,
                online: true
            ),
        ])

        XCTAssertEqual(presented.first?.displayName, "Connected bridge")
    }

    func testShortAndFqdnHostIdentityMergeForStaleLabeling() {
        let presented = BridgePresentationPolicy.present([
            BridgeRosterEntry(
                id: "br-short",
                name: "mini",
                capabilities: [],
                grantedCapabilities: [],
                createdAt: 1,
                lastSeenAt: 2,
                hostInfo: "macmini",
                online: false
            ),
            BridgeRosterEntry(
                id: "br-fqdn",
                name: "mini",
                capabilities: [],
                grantedCapabilities: [],
                createdAt: 10,
                lastSeenAt: 20,
                hostInfo: "macmini.local",
                online: true
            ),
        ])

        XCTAssertEqual(presented.map(\.id), ["br-fqdn", "br-short"])
        XCTAssertTrue(presented[1].stale)
    }
}
