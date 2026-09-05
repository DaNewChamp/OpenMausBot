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

    func testConnectedComputerCountExcludesOfflineAndStaleNodes() {
        let bridges = [
            BridgeRosterEntry(
                id: "br-mini-online",
                name: "mini",
                capabilities: ["shell"],
                grantedCapabilities: ["shell"],
                createdAt: 10,
                lastSeenAt: 20,
                hostInfo: "macmini.local",
                online: true
            ),
            BridgeRosterEntry(
                id: "br-windows-online",
                name: "windows",
                capabilities: ["shell"],
                grantedCapabilities: ["shell"],
                createdAt: 10,
                lastSeenAt: 20,
                hostInfo: "pc.lan",
                online: true
            ),
            BridgeRosterEntry(
                id: "br-linux-offline",
                name: "linux",
                capabilities: ["shell"],
                grantedCapabilities: ["shell"],
                createdAt: 5,
                lastSeenAt: 15,
                hostInfo: "vps.lan",
                online: false
            ),
            BridgeRosterEntry(
                id: "br-mini-stale",
                name: "mini",
                capabilities: ["shell"],
                grantedCapabilities: ["shell"],
                createdAt: 1,
                lastSeenAt: 2,
                hostInfo: "macmini.local",
                online: false
            ),
        ]

        let count = BridgePresentationPolicy.connectedComputerCount(in: bridges)
        XCTAssertEqual(count, 2)
        XCTAssertEqual(
            ConnectionPresentationPolicy.computerSummary(hubCount: 1, connectedComputerCount: count),
            "1 hub · 2 connected computers"
        )
    }
}

