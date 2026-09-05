import XCTest
@testable import CompanionCore

final class ModelPickerDraftPolicyTests: XCTestCase {
    func testProviderBrowseDoesNotChangeResolvedSelection() {
        let instances = sampleInstances()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "high")
        var draft = ModelPickerDraftPolicy.makeDraft(
            selection: opened,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: opened)
        )
        let before = draft
        draft = ModelPickerDraftPolicy.browseProvider("claude", draft: draft)
        XCTAssertEqual(draft.browsingProviderId, "claude")
        XCTAssertEqual(draft.instanceId, before.instanceId)
        XCTAssertEqual(draft.modelId, before.modelId)
        XCTAssertEqual(draft.effort, before.effort)
        XCTAssertEqual(draft.familyKey, before.familyKey)
        XCTAssertEqual(
            ModelPickerDraftPolicy.resolvedSelection(draft: draft, instances: instances),
            opened
        )
    }

    func testFamilyAndToggleEditsStayDraftUntilOneApplyTransaction() throws {
        let instances = sampleInstances()
        let opened = ModelSelection(instanceId: "cursor", model: "gpt-5.3-codex-high")
        var draft = ModelPickerDraftPolicy.makeDraft(
            selection: opened,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: opened)
        )
        draft = try XCTUnwrap(ModelPickerDraftPolicy.setEffort("low", draft: draft, instances: instances))
        XCTAssertEqual(draft.modelId, "gpt-5.3-codex-low")
        XCTAssertEqual(opened.model, "gpt-5.3-codex-high")

        draft = try XCTUnwrap(ModelPickerDraftPolicy.setFast(true, draft: draft, instances: instances))
        XCTAssertEqual(draft.modelId, "gpt-5.3-codex-low-fast")

        XCTAssertNil(
            ModelPickerDraftPolicy.applyBlock(
                draft: draft,
                remote: opened,
                working: false,
                canEdit: true,
                saving: false,
                catalogLoading: false,
                hostWide: false,
                instances: instances
            )
        )
        let patch = try XCTUnwrap(ModelPickerDraftPolicy.patch(from: draft, instances: instances))
        XCTAssertEqual(patch.instanceId, "cursor")
        XCTAssertEqual(patch.model, "gpt-5.3-codex-low-fast")
        XCTAssertEqual(patch.effort, .omitted)
    }

    func testCancelDiscardsDraftAndBrowseMutationsAreZeroPatches() {
        let instances = sampleInstances()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        var draft = ModelPickerDraftPolicy.makeDraft(
            selection: opened,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: opened)
        )
        draft = ModelPickerDraftPolicy.browseProvider("cursor", draft: draft)
        draft = ModelPickerDraftPolicy.setSearch("terra", draft: draft)
        draft = ModelPickerDraftPolicy.setShowingMore(true, draft: draft)
        XCTAssertTrue(ModelPickerDraftPolicy.cancelDiscardsWithoutPatch(draft: draft, openedWith: opened))
        XCTAssertEqual(
            ModelPickerDraftPolicy.resolvedSelection(draft: draft, instances: instances),
            opened
        )
    }

    func testApplyDisabledWhenBusyOfflineSavingInvalidUnchangedOrRemoteUpdated() {
        let instances = sampleInstances()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "medium")
        let draft = ModelPickerDraftPolicy.makeDraft(
            selection: opened,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: opened)
        )
        XCTAssertEqual(
            ModelPickerDraftPolicy.applyBlock(
                draft: draft, remote: opened, working: false, canEdit: true,
                saving: false, catalogLoading: false, hostWide: false, instances: instances
            ),
            .unchanged
        )
        XCTAssertEqual(
            ModelPickerDraftPolicy.applyBlock(
                draft: draft, remote: opened, working: true, canEdit: true,
                saving: false, catalogLoading: false, hostWide: false, instances: instances
            ),
            .busy
        )
        XCTAssertEqual(
            ModelPickerDraftPolicy.applyBlock(
                draft: draft, remote: opened, working: false, canEdit: false,
                saving: false, catalogLoading: false, hostWide: false, instances: instances
            ),
            .offline
        )
        XCTAssertEqual(
            ModelPickerDraftPolicy.applyBlock(
                draft: draft, remote: opened, working: false, canEdit: true,
                saving: true, catalogLoading: false, hostWide: false, instances: instances
            ),
            .saving
        )
        XCTAssertEqual(
            ModelPickerDraftPolicy.applyBlock(
                draft: draft, remote: opened, working: false, canEdit: true,
                saving: false, catalogLoading: true, hostWide: false, instances: instances
            ),
            .catalogLoading
        )

        var switched = draft
        switched = ModelPickerDraftPolicy.selectFamily(
            "gpt-5.6-terra",
            draft: switched,
            instances: instances
        ) ?? switched
        XCTAssertEqual(switched.instanceId, "codex")
        XCTAssertEqual(switched.modelId, "gpt-5.6-terra")
        XCTAssertEqual(
            ModelPickerDraftPolicy.applyBlock(
                draft: switched,
                remote: ModelSelection(instanceId: "codex", model: "gpt-5.6-luna"),
                working: false,
                canEdit: true,
                saving: false,
                catalogLoading: false,
                hostWide: false,
                instances: instances
            ),
            .remoteUpdated
        )
    }

    func testSelectingFamilyWithoutCurrentSourceDoesNotPretendACombination() {
        let instances = sampleInstances()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        var draft = ModelPickerDraftPolicy.makeDraft(
            selection: opened,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: opened)
        )
        XCTAssertNil(
            ModelPickerDraftPolicy.selectFamily("gpt-5.3-codex", draft: draft, instances: instances),
            "Codex does not advertise gpt-5.3-codex; do not switch to Cursor"
        )
        draft = ModelPickerDraftPolicy.selectSource(
            "cursor",
            familyKey: "gpt-5.3-codex",
            draft: draft,
            instances: instances
        ) ?? draft
        XCTAssertEqual(draft.instanceId, "cursor")
        XCTAssertEqual(ModelFamilyPolicy.parse(draft.modelId).familyKey, "gpt-5.3-codex")
    }

    func testHermesConfirmationIsNotTriggeredByProviderBrowse() {
        XCTAssertTrue(HermesConversionConfirmationPolicy.requiresConfirmationBeforeApply(fromModelPicker: true))
        XCTAssertFalse(HermesConversionConfirmationPolicy.shouldApplyRuntimeOnEndpointSelection())
        let instances = sampleInstances()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        let draft = ModelPickerDraftPolicy.makeDraft(
            selection: opened,
            instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: opened)
        )
        let browsed = ModelPickerDraftPolicy.browseProvider("claude", draft: draft)
        XCTAssertEqual(browsed.instanceId, "codex")
        XCTAssertEqual(browsed.modelId, "gpt-5.6-sol")
    }

    func testCompactHeaderSummaryIncludesEffortAndFastWithDiscoverableSource() {
        XCTAssertEqual(
            ModelSelectionPolicy.compactHeaderSummary(familyLabel: "GPT-5.6 Sol", effort: "high", fast: true),
            "GPT-5.6 Sol · High · Fast"
        )
        XCTAssertEqual(
            ModelSelectionPolicy.compactHeaderSummary(familyLabel: "Claude Sonnet 5", effort: nil, fast: false),
            "Claude Sonnet 5"
        )
        XCTAssertEqual(
            ModelSelectionPolicy.compactHeaderSourceLabel(instanceDisplayName: "Codex"),
            "Codex"
        )
    }

    func testFastGenerationDoesNotShareTheAutoPickBoolean() {
        XCTAssertEqual(ModelSelectionPolicy.fastGenerationTitle, "Fast generation")
        XCTAssertEqual(ModelSelectionPolicy.fastModeTitle, "Auto-pick a faster model")
        XCTAssertNotEqual(ModelSelectionPolicy.fastGenerationTitle, ModelSelectionPolicy.fastModeTitle)
        XCTAssertTrue(ModelSelectionPolicy.fastModeHint.localizedCaseInsensitiveContains("different"))
        XCTAssertFalse(ModelSelectionPolicy.fastGenerationHint.localizedCaseInsensitiveContains("engine"))
    }

    func testProviderTapPolicyDoesNotRewriteSelection() {
        let advertised = sampleInstances()
        let current = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        let rails = ProviderCatalogPolicy.groupedInstances(advertised: advertised, selection: current)
        let claude = rails.first { $0.instanceId == "claude" }
        XCTAssertNil(
            ProviderCatalogPolicy.selectionAfterProviderTap(
                current: current,
                tapped: claude!,
                advertised: advertised
            )
        )
        XCTAssertEqual(
            ProviderCatalogPolicy.selectionAfterModelTap(
                current: current,
                rail: rails.first { $0.instanceId == "openai" },
                modelId: "gpt-5.6-sol",
                sourceInstanceId: "codex"
            )?.instanceId,
            "codex"
        )
        let firstMatch = ProviderCatalogPolicy.selectionAfterModelTap(
            current: current,
            rail: rails.first { $0.instanceId == "openai" },
            modelId: "gpt-5.6-sol"
        )
        XCTAssertEqual(firstMatch?.instanceId, "codex", "Ambiguous model-id taps must not first-match offline Droid")
        let droidTap = ProviderCatalogPolicy.selectionAfterModelTap(
            current: current,
            rail: rails.first { $0.instanceId == "openai" },
            modelId: "gpt-5.6-sol",
            sourceInstanceId: "droid"
        )
        XCTAssertEqual(droidTap?.instanceId, "droid")
        XCTAssertEqual(droidTap?.model, "gpt-5.6-sol")
    }

    private func sampleInstances() -> [Instance] {
        [
            Instance(
                instanceId: "codex",
                driverKind: "codex",
                displayName: "Codex",
                snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
                models: ModelCatalog(
                    default: "gpt-5.6-sol",
                    options: [
                        ModelOption(id: "gpt-5.6-sol", label: "GPT-5.6 Sol"),
                        ModelOption(id: "gpt-5.6-terra", label: "GPT-5.6 Terra"),
                        ModelOption(id: "gpt-5.6-luna", label: "GPT-5.6 Luna"),
                    ]
                ),
                capabilities: InstanceCapabilities(
                    computerMcp: true,
                    localComputerMcp: true,
                    effortLevels: ["low", "medium", "high", "xhigh", "max"]
                )
            ),
            Instance(
                instanceId: "droid",
                driverKind: "droidAgent",
                displayName: "Droid",
                snapshot: ProviderSnapshot(
                    state: "unavailable",
                    reason: "`droid` CLI not found",
                    authenticated: nil,
                    version: nil
                ),
                models: ModelCatalog(
                    default: "gpt-5.6-sol",
                    options: [ModelOption(id: "gpt-5.6-sol", label: "GPT-5.6 Sol")]
                )
            ),
            Instance(
                instanceId: "cursor",
                driverKind: "cursorAgent",
                displayName: "Cursor",
                snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
                models: ModelCatalog(
                    default: "auto",
                    options: [
                        ModelOption(id: "auto", label: "Auto"),
                        ModelOption(id: "gpt-5.3-codex-high", label: "Codex 5.3 High"),
                        ModelOption(id: "gpt-5.3-codex-low", label: "Codex 5.3 Low"),
                        ModelOption(id: "gpt-5.3-codex-low-fast", label: "Codex 5.3 Low Fast"),
                        ModelOption(id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High"),
                    ]
                )
            ),
            Instance(
                instanceId: "claude",
                driverKind: "claudeAgent",
                displayName: "Claude",
                snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
                models: ModelCatalog(
                    default: "claude-sonnet-5",
                    options: [ModelOption(id: "claude-sonnet-5", label: "Claude Sonnet 5")]
                ),
                capabilities: InstanceCapabilities(
                    computerMcp: true,
                    localComputerMcp: true,
                    effortLevels: ["low", "medium", "high", "xhigh", "max"]
                )
            ),
        ]
    }
}
