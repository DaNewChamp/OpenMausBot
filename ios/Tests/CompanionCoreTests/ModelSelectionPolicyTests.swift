import XCTest
@testable import CompanionCore

final class ModelSelectionPolicyTests: XCTestCase {
    func testWorkingBlocksSelectionForAnyAdvertisedEngine() {
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: true))
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: true, saving: false, catalogLoading: false))
        XCTAssertEqual(
            ModelSelectionPolicy.footerHint(working: true),
            ModelSelectionPolicy.busyExplanation
        )
    }

    func testInterruptOrSettleReenablesSelection() {
        XCTAssertTrue(ModelSelectionPolicy.allowsSwitch(working: false))
        XCTAssertEqual(
            ModelSelectionPolicy.footerHint(working: false),
            ModelSelectionPolicy.idleHint
        )
    }

    func testSavingAndCatalogLoadAlsoBlockWithoutProviderNames() {
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: false, saving: true))
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: false, catalogLoading: true))
        XCTAssertTrue(ModelSelectionPolicy.allowsSwitch(working: false, saving: false, catalogLoading: false))
    }

    func testBusyCopyDoesNotNameAProvider() {
        XCTAssertFalse(ModelSelectionPolicy.busyExplanation.localizedCaseInsensitiveContains("codex"))
        XCTAssertFalse(ModelSelectionPolicy.busyExplanation.localizedCaseInsensitiveContains("claude"))
        XCTAssertFalse(ModelSelectionPolicy.busyExplanation.localizedCaseInsensitiveContains("grok"))
        XCTAssertFalse(ModelSelectionPolicy.busyExplanation.localizedCaseInsensitiveContains("cursor"))
        XCTAssertFalse(ModelSelectionPolicy.idleHint.localizedCaseInsensitiveContains("codex"))
    }
}
