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
            ModelSelectionPolicy.fastModeTitle,
            ModelSelectionPolicy.fastGenerationTitle,
            ModelSelectionPolicy.fastGenerationHint,
            ModelSelectionPolicy.currentModelUnavailable,
            ModelSelectionPolicy.providerKeepsLocalModel,
            ModelSelectionPolicy.refreshingExplanation,
            ModelSelectionPolicy.managedByServer,
            ModelSelectionPolicy.refreshModels,
        ] {
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("codex"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("claude"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("grok"))
            XCTAssertFalse(copy.localizedCaseInsensitiveContains("cursor"))
        }
        XCTAssertEqual(ModelSelectionPolicy.emptyCatalogExplanation, "No models on computer")
        XCTAssertEqual(ModelSelectionPolicy.fastModeTitle, "Auto-pick a faster model")
        XCTAssertEqual(ModelSelectionPolicy.fastGenerationTitle, "Fast generation")
        XCTAssertEqual(ModelSelectionPolicy.currentModelUnavailable, "Current model unavailable")
        XCTAssertNotEqual(ModelSelectionPolicy.fastModeTitle, ModelSelectionPolicy.fastGenerationTitle)
        XCTAssertFalse(ModelSelectionPolicy.fastModeHint.localizedCaseInsensitiveContains("fast generation"))
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
            "\(ModelSelectionPolicy.idleHint) \(ModelSelectionPolicy.managedByServer)"
        )
    }

    func testCatalogSurfaceLoadingErrorEmptyOfflineAndReady() {
        let catalog = [Self.sampleInstance(id: "alpha", models: ["alpha-1"])]
        XCTAssertEqual(
            ModelCatalogPresentation.surface(loading: true, error: nil, instances: [], canEdit: true),
            .loading
        )
        let refreshing = ModelCatalogPresentation.surface(
            loading: true,
            error: nil,
            instances: catalog,
            canEdit: true
        )
        XCTAssertEqual(
            refreshing,
            .catalog(cachedOffline: false, refreshError: nil, refreshing: true)
        )
        XCTAssertTrue(refreshing.selectionDisabled)
        XCTAssertTrue(refreshing.isRefreshing)
        XCTAssertTrue(refreshing.showsCatalogRows)
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
            .catalog(cachedOffline: true, refreshError: nil, refreshing: false)
        )
        XCTAssertTrue(
            ModelCatalogPresentation.surface(loading: false, error: nil, instances: catalog, canEdit: false)
                .selectionDisabled
        )
        let ready = ModelCatalogPresentation.surface(
            loading: false,
            error: nil,
            instances: catalog,
            canEdit: true
        )
        XCTAssertEqual(ready, .catalog(cachedOffline: false, refreshError: nil, refreshing: false))
        XCTAssertFalse(ready.selectionDisabled)
        XCTAssertFalse(ready.isRefreshing)

        let stale = ModelCatalogPresentation.surface(
            loading: false,
            error: "timeout",
            instances: catalog,
            canEdit: true
        )
        XCTAssertEqual(stale, .catalog(cachedOffline: true, refreshError: "timeout", refreshing: false))
        XCTAssertTrue(stale.selectionDisabled)
        XCTAssertEqual(stale.refreshError, "timeout")
        XCTAssertTrue(stale.showsCatalogRows)
        XCTAssertFalse(stale.isRefreshing)
    }

    func testWarmCacheRefreshReenablesOnlyOnSuccess() {
        let catalog = [Self.sampleInstance(id: "alpha", models: ["alpha-1"])]
        let inFlight = ModelCatalogPresentation.surface(
            loading: true,
            error: nil,
            instances: catalog,
            canEdit: true
        )
        XCTAssertTrue(inFlight.selectionDisabled)
        XCTAssertTrue(inFlight.isRefreshing)

        let failed = ModelCatalogPresentation.surface(
            loading: false,
            error: "timeout",
            instances: catalog,
            canEdit: true
        )
        XCTAssertTrue(failed.selectionDisabled)
        XCTAssertFalse(failed.isRefreshing)

        let succeeded = ModelCatalogPresentation.surface(
            loading: false,
            error: nil,
            instances: catalog,
            canEdit: true
        )
        XCTAssertFalse(succeeded.selectionDisabled)
        XCTAssertFalse(succeeded.isRefreshing)
    }

    func testEmptyAdvertisedCatalogHostUsesRailPolicyOrphan() {
        let selection = ModelSelection(instanceId: "retired", model: "retired-1")
        let orphaned = ModelCatalogPresentation.surface(
            loading: false,
            error: nil,
            instances: [],
            canEdit: true,
            selection: selection
        )
        XCTAssertNotEqual(orphaned, .empty)
        XCTAssertEqual(
            orphaned,
            .catalog(cachedOffline: false, refreshError: nil, refreshing: false)
        )
        XCTAssertTrue(orphaned.showsCatalogRows)
        XCTAssertFalse(ModelPickerRailPolicy.isEmpty(advertised: [], selection: selection))

        let genericEmpty = ModelCatalogPresentation.surface(
            loading: false,
            error: nil,
            instances: [],
            canEdit: true,
            selection: ModelSelection(instanceId: "", model: "")
        )
        XCTAssertEqual(genericEmpty, .empty)

        let offlineOrphan = ModelCatalogPresentation.surface(
            loading: false,
            error: nil,
            instances: [],
            canEdit: false,
            selection: selection
        )
        XCTAssertEqual(
            offlineOrphan,
            .catalog(cachedOffline: true, refreshError: nil, refreshing: false)
        )
        XCTAssertTrue(offlineOrphan.selectionDisabled)
    }

    func testBusyRevertInvalidationIsScopedByMutationOwner() {
        XCTAssertEqual(
            InterruptedModelWritePolicy.invalidationTargets(
                botId: "a",
                mutationTarget: .openmaus,
                inFlightRouterOwner: .settings
            ),
            [.advertisedBot("a")]
        )
        XCTAssertEqual(
            InterruptedModelWritePolicy.invalidationTargets(
                botId: "a",
                mutationTarget: .openmaus,
                inFlightRouterOwner: .bot("a")
            ),
            [.advertisedBot("a")]
        )
        XCTAssertEqual(
            InterruptedModelWritePolicy.invalidationTargets(
                botId: "a",
                mutationTarget: .grokReconstructed,
                inFlightRouterOwner: .settings
            ),
            [.advertisedBot("a")]
        )
        XCTAssertEqual(
            InterruptedModelWritePolicy.invalidationTargets(
                botId: "a",
                mutationTarget: .grokReconstructed,
                inFlightRouterOwner: .bot("b")
            ),
            [.advertisedBot("a")]
        )
        XCTAssertEqual(
            InterruptedModelWritePolicy.invalidationTargets(
                botId: "a",
                mutationTarget: .grokReconstructed,
                inFlightRouterOwner: .bot("a")
            ),
            [.advertisedBot("a"), .reconstructedRouter]
        )
        XCTAssertTrue(InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true))
        XCTAssertFalse(InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: false))
        XCTAssertTrue(InterruptedModelWritePolicy.shouldHoldTurnUntilHydrate(unconfirmedWrite: true))
        XCTAssertFalse(InterruptedModelWritePolicy.shouldHoldTurnUntilHydrate(unconfirmedWrite: false))
    }

    func testModelsDisabledFollowsAdvertisedFlagNotVendorName() {
        var locked = Self.sampleInstance(id: "hosted", models: ["hosted-1"])
        locked.modelSelectable = false
        XCTAssertTrue(ModelSelectionPolicy.modelsDisabled(for: locked, hostWideEngine: false))
        XCTAssertFalse(ModelSelectionPolicy.modelsDisabled(for: Self.sampleInstance(id: "open", models: ["open-1"]), hostWideEngine: false))
        XCTAssertFalse(ModelSelectionPolicy.showsEffortPicker(levels: ["low"], hostWideEngine: true))
        XCTAssertTrue(ModelSelectionPolicy.showsEffortPicker(levels: ["low"], hostWideEngine: false))
    }

    func testHermesRuntimeRowsStayComputerAndProfileAndKeepProviderModelsConcise() {
        let hermes = HermesEndpointOption(id: "bridge:mini:research", computerName: "Mac mini", profile: "research")
        XCTAssertEqual(ModelSelectionPolicy.hermesRuntimeLabel(hermes), "Mac mini / research")
        XCTAssertEqual(ModelSelectionPolicy.subscriptionModelLabel("claude-sonnet-5"), "claude-sonnet-5")
        XCTAssertFalse(ModelSelectionPolicy.subscriptionModelLabel("claude-sonnet-5").contains("/"))
        XCTAssertTrue(ModelSelectionPolicy.allowsHermesRuntimeSwitch(working: false))
        XCTAssertFalse(ModelSelectionPolicy.allowsHermesRuntimeSwitch(working: true))
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
