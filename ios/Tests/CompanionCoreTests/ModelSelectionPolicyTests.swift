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
        XCTAssertFalse(ModelSelectionPolicy.shouldRevertDraft(wasWorking: true, isWorking: false))
        XCTAssertTrue(ModelSelectionPolicy.shouldRevertDraft(wasWorking: false, isWorking: true))
        XCTAssertFalse(ModelSelectionPolicy.shouldRevertDraft(wasWorking: true, isWorking: true))
    }

    func testSavingAndCatalogLoadAlsoBlockWithoutProviderNames() {
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: false, saving: true))
        XCTAssertFalse(ModelSelectionPolicy.allowsSwitch(working: false, catalogLoading: true))
        XCTAssertTrue(ModelSelectionPolicy.allowsSwitch(working: false, saving: false, catalogLoading: false))
    }

    func testBusyCopyDoesNotNameAProvider() {
        for copy in [
            ModelSelectionPolicy.busyExplanation,
            ModelSelectionPolicy.idleHint,
            ModelSelectionPolicy.emptyCatalogExplanation,
            ModelSelectionPolicy.hostWideHint,
            ModelSelectionPolicy.fastModeHint,
            ModelSelectionPolicy.providerKeepsLocalModel,
        ] {
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("codex"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("claude"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("grok"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("cursor"))
        }
        XCTAssertEqual(ModelSelectionPolicy.emptyCatalogExplanation, "No models on computer")
    }

    func testStaleRevisionIsIgnored() {
        XCTAssertTrue(ModelSelectionPolicy.shouldApplyResponse(requestRevision: 3, currentRevision: 3))
        XCTAssertFalse(ModelSelectionPolicy.shouldApplyResponse(requestRevision: 2, currentRevision: 3))
        XCTAssertFalse(ModelSelectionPolicy.shouldApplyResponse(requestRevision: 4, currentRevision: 3))
    }

    func testFooterPrefersReconnectThenBusyThenHostWide() {
        XCTAssertEqual(
            ModelSelectionPolicy.footerHint(working: false, canEdit: false, hostWide: true),
            CalmSurfacePolicy.reconnectToEdit
        )
        XCTAssertEqual(
            ModelSelectionPolicy.footerHint(working: true, canEdit: true, hostWide: true),
            ModelSelectionPolicy.busyExplanation
        )
        XCTAssertEqual(
            ModelSelectionPolicy.footerHint(working: false, canEdit: true, hostWide: true),
            ModelSelectionPolicy.hostWideHint
        )
        XCTAssertEqual(
            ModelSelectionPolicy.footerHint(working: false, canEdit: true, hostWide: false),
            ModelSelectionPolicy.idleHint
        )
    }

    func testCatalogSurfaceLoadingErrorEmptyOfflineAndReady() {
        let catalog = [Self.sampleInstance(id: "alpha", models: ["alpha-1"])]
        XCTAssertEqual(
            ModelCatalogPresentation.surface(loading: true, error: nil, instances: [], canEdit: true),
            .loading
        )
        XCTAssertEqual(
            ModelCatalogPresentation.surface(loading: true, error: nil, instances: catalog, canEdit: true),
            .catalog(cachedOffline: false)
        )
        XCTAssertEqual(
            ModelCatalogPresentation.surface(loading: false, error: "timeout", instances: [], canEdit: true),
            .error("timeout")
        )
        XCTAssertEqual(
            ModelCatalogPresentation.surface(loading: false, error: nil, instances: [], canEdit: true),
            .empty
        )
        XCTAssertEqual(
            ModelCatalogPresentation.surface(loading: false, error: "timeout", instances: catalog, canEdit: false),
            .catalog(cachedOffline: true)
        )
        XCTAssertTrue(
            ModelCatalogPresentation.surface(loading: false, error: nil, instances: catalog, canEdit: false)
                .selectionDisabled
        )
        XCTAssertFalse(
            ModelCatalogPresentation.surface(loading: false, error: nil, instances: catalog, canEdit: true)
                .selectionDisabled
        )
    }

    func testModelsDisabledFollowsAdvertisedFlagNotVendorName() {
        var locked = Self.sampleInstance(id: "hosted", models: ["hosted-1"])
        locked.modelSelectable = false
        XCTAssertTrue(ModelSelectionPolicy.modelsDisabled(for: locked, hostWideEngine: false))
        XCTAssertFalse(ModelSelectionPolicy.modelsDisabled(for: Self.sampleInstance(id: "open", models: ["open-1"]), hostWideEngine: false))
        XCTAssertFalse(ModelSelectionPolicy.showsEffortPicker(levels: ["low"], hostWideEngine: true))
        XCTAssertTrue(ModelSelectionPolicy.showsEffortPicker(levels: ["low"], hostWideEngine: false))
    }

    private static func sampleInstance(id: String, models: [String]) -> Instance {
        Instance(
            instanceId: id,
            driverKind: id,
            displayName: id,
            snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(
                default: models.first ?? "",
                options: models.map { ModelOption(id: $0, label: $0) }
            )
        )
    }
}
