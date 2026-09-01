import XCTest
@testable import CompanionCore

final class BridgeRosterLoadPolicyTests: XCTestCase {
    func testSwitchingConnectionRejectsOldRosterAndSettlesNewRoster() {
        var gate = BridgeRosterRefreshGate()
        let oldRequest = gate.beginLoad(for: "home")

        gate.invalidate()
        let newRequest = gate.beginLoad(for: "office")

        XCTAssertFalse(gate.finishLoad(oldRequest, currentConnectionID: "office"))
        XCTAssertTrue(gate.refreshing)
        XCTAssertTrue(gate.finishLoad(newRequest, currentConnectionID: "office"))
        XCTAssertFalse(gate.refreshing)
    }

    func testCurrentConnectionIdIsRequiredEvenForTheNewestGeneration() {
        var gate = BridgeRosterRefreshGate()
        let request = gate.beginLoad(for: "home")

        XCTAssertTrue(
            BridgeRosterLoadPolicy.shouldApply(
                request: request,
                currentGeneration: request.generation,
                currentConnectionID: "home"
            )
        )
        XCTAssertFalse(gate.finishLoad(request, currentConnectionID: "office"))
        XCTAssertTrue(gate.refreshing)
        XCTAssertTrue(gate.finishLoad(request, currentConnectionID: "home"))
    }

    func testInvalidateClearsSelectedConnectionAndLoadingState() {
        var gate = BridgeRosterRefreshGate()
        _ = gate.beginLoad(for: "home")

        gate.invalidate()

        XCTAssertNil(gate.connectionID)
        XCTAssertFalse(gate.refreshing)
    }
}
