import Foundation
import XCTest
@testable import CompanionCore

final class WebPairingTests: XCTestCase {
    func testParsesTheVersionedWebPairLinkAndRejectsTheOldPairHost() throws {
        let hash = String(repeating: "a", count: 64)
        let rid = String(repeating: "b", count: 22)
        let url = try XCTUnwrap(URL(string:
            "openmausbot://web-pair?v=1&hub=https://hub-vbot.posival.com&hid=hub-1&rid=\(rid)&ch=\(hash)&n=Vincent%27s%20browser&exp=1735689600000"
        ))
        let request = try XCTUnwrap(WebPairingRequest.parse(url))
        XCTAssertEqual(request.version, 1)
        XCTAssertEqual(request.hubOrigin, "https://hub-vbot.posival.com")
        XCTAssertEqual(request.hubId, "hub-1")
        XCTAssertEqual(request.requestId, rid)
        XCTAssertEqual(request.challengeHash, hash)
        XCTAssertEqual(request.deviceName, "Vincent's browser")
        XCTAssertEqual(request.expiresAt, 1_735_689_600_000)
        XCTAssertNil(PairingInvite.parse(url))
        XCTAssertNil(WebPairingRequest.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=004209"))))
    }

    func testRejectsSecretBearingAliasesAndOtherVersions() throws {
        let hash = String(repeating: "a", count: 64)
        let rid = String(repeating: "b", count: 22)
        let base = "openmausbot://web-pair?v=1&hub=https://hub-vbot.posival.com&hid=hub-1&rid=\(rid)&ch=\(hash)&n=Browser&exp=1735689600000"
        XCTAssertNil(WebPairingRequest.parse(try XCTUnwrap(URL(string: base + "&token=omb_pair_" + String(repeating: "c", count: 43)))))
        XCTAssertNil(WebPairingRequest.parse(try XCTUnwrap(URL(string: base + "&code=004209"))))
        XCTAssertNil(WebPairingRequest.parse(try XCTUnwrap(URL(string: base + "&redeemSecret=nope"))))
        let otherVersion = try XCTUnwrap(URL(string: base.replacingOccurrences(of: "v=1", with: "v=2")))
        XCTAssertNil(WebPairingRequest.parse(otherVersion))
    }

    func testOpenMausBotLinkDispatchesPairAndWebPairSeparately() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let pair = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&token=\(token)&code=004209"))
        if case .firstDevicePair(let invite) = OpenMausBotLink.parse(pair) {
            XCTAssertEqual(invite.credential, token)
        } else {
            XCTFail("expected first-device pair")
        }

        let hash = String(repeating: "a", count: 64)
        let rid = String(repeating: "b", count: 22)
        let web = try XCTUnwrap(URL(string:
            "openmausbot://web-pair?v=1&hub=https://hub-vbot.posival.com&hid=hub-1&rid=\(rid)&ch=\(hash)&n=Browser&exp=1735689600000"
        ))
        if case .webPairing = OpenMausBotLink.parse(web) {
            // dispatched
        } else {
            XCTFail("expected web pairing")
        }
    }

    func testApprovalRequiresAnAlreadyPairedPhoneExplicitConfirmAndTheRightHub() throws {
        let hash = String(repeating: "a", count: 64)
        let rid = String(repeating: "b", count: 22)
        let url = try XCTUnwrap(URL(string:
            "openmausbot://web-pair?v=1&hub=https://hub-vbot.posival.com&hid=hub-1&rid=\(rid)&ch=\(hash)&n=Vincent%27s%20browser&exp=1735689600000"
        ))
        let request = try XCTUnwrap(WebPairingRequest.parse(url))
        XCTAssertFalse(WebPairingScanPolicy.shouldAutoApprove(request))

        if case .reject = WebPairingScanPolicy.outcome(
            for: url, isPaired: false, pairingRequested: false, pairedOrigins: []
        ) {
            // unpaired phones cannot approve
        } else {
            XCTFail("unpaired scan must reject")
        }

        if case .reject = WebPairingScanPolicy.outcome(
            for: url,
            isPaired: true,
            pairingRequested: false,
            pairedOrigins: ["https://other-hub.example"]
        ) {
            // wrong hub
        } else {
            XCTFail("wrong hub must reject")
        }

        if case .confirmWebPairing(let pending) = WebPairingScanPolicy.outcome(
            for: url,
            isPaired: true,
            pairingRequested: false,
            pairedOrigins: ["https://hub-vbot.posival.com"]
        ) {
            XCTAssertEqual(pending.requestId, rid)
            XCTAssertEqual(
                WebPairingScanPolicy.confirmationTitle(deviceName: pending.deviceName),
                "Approve Vincent's browser?"
            )
            XCTAssertTrue(
                WebPairingScanPolicy.confirmationMessage(deviceName: pending.deviceName, hubName: "Vincent's computer")
                    .contains("Vincent's browser")
            )
            XCTAssertTrue(
                WebPairingScanPolicy.confirmationMessage(deviceName: pending.deviceName, hubName: "Vincent's computer")
                    .contains("Vincent's computer")
            )
        } else {
            XCTFail("paired matching hub must confirm, not auto-approve")
        }

        if case .confirmWebPairing = WebPairingScanPolicy.outcome(
            for: url,
            isPaired: true,
            pairingRequested: false,
            pairedOrigins: ["http://192.168.1.42:8810", "https://hub-vbot.posival.com"]
        ) {
            // LAN-paired phones may still approve a hosted browser QR for the same hub
        } else {
            XCTFail("authorized hosted origin on a LAN-paired phone must confirm")
        }
    }

    func testOldPairPathStillParsesWhenUnpairedAndIsBlockedWhenAlreadyPaired() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&token=\(token)&code=004209"))
        if case .beginFirstDevicePair = WebPairingScanPolicy.outcome(
            for: url, isPaired: false, pairingRequested: false, pairedOrigins: []
        ) {
            // first-device flow unchanged
        } else {
            XCTFail("unpaired phone must still accept openmausbot://pair")
        }
        if case .reject(let message) = WebPairingScanPolicy.outcome(
            for: url, isPaired: true, pairingRequested: false, pairedOrigins: ["http://mac.local:8810"]
        ) {
            XCTAssertTrue(message.contains("already paired"))
        } else {
            XCTFail("already-paired phone must not auto-switch on the old pair QR")
        }
    }

    func testApproveRequestUsesThePairedBearerPath() throws {
        let hash = String(repeating: "a", count: 64)
        let request = WebPairingRequest(
            hubOrigin: "https://hub-vbot.posival.com",
            hubId: "hub-1",
            requestId: String(repeating: "b", count: 22),
            challengeHash: hash,
            deviceName: "Browser",
            expiresAt: 1_735_689_600_000
        )
        XCTAssertEqual(request.requestId.utf8.count, 22)
        XCTAssertFalse(WebPairingScanPolicy.shouldAutoApprove(request))
    }
}
