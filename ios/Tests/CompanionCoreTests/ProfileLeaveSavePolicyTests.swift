import XCTest
@testable import CompanionCore

final class ProfileLeaveSavePolicyTests: XCTestCase {
    func testDismissNeverWaitsOnNetwork() {
        XCTAssertFalse(ProfileLeaveSavePolicy.blocksDismissOnSave)
    }

    func testProfileSaveQueuedAfterDismissWhenDirty() {
        let plan = ProfileLeaveSavePolicy.leavePlan(profileDirty: true, modelDirty: false)
        XCTAssertTrue(plan.saveProfileAfterDismiss)
        XCTAssertFalse(plan.cancelInFlightModelSave)
    }

    func testCleanProfileSkipsSaveOnLeave() {
        let plan = ProfileLeaveSavePolicy.leavePlan(profileDirty: false, modelDirty: false)
        XCTAssertFalse(plan.saveProfileAfterDismiss)
    }

    func testInFlightModelSaveContinuesOnLeave() {
        let plan = ProfileLeaveSavePolicy.leavePlan(profileDirty: false, modelDirty: true)
        XCTAssertFalse(plan.saveProfileAfterDismiss)
        XCTAssertFalse(plan.cancelInFlightModelSave)
    }

    func testSwipeDismissUsesSameAsyncProfileSavePlan() {
        XCTAssertEqual(
            ProfileLeaveSavePolicy.swipeDismissPlan(profileDirty: true),
            ProfileLeaveSavePolicy.leavePlan(profileDirty: true, modelDirty: false)
        )
    }
}
