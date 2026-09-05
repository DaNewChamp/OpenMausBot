import XCTest
@testable import CompanionCore

final class ModelPickerRegressionTests: XCTestCase {
    private func captured() throws -> [Instance] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "model-catalog-20260905", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(InstanceList.self, from: Data(contentsOf: url)).instances
    }
    private func make(_ selection: ModelSelection, _ instances: [Instance]) -> ModelPickerDraft {
        ModelPickerDraftPolicy.makeDraft(selection: selection, instances: instances,
            catalog: ModelFamilyPolicy.catalog(from: instances, selection: selection))
    }
    private func block(_ draft: ModelPickerDraft, _ instances: [Instance]) -> ModelPickerApplyBlock? {
        ModelPickerDraftPolicy.applyBlock(draft: draft, remote: draft.openedWith, working: false,
            canEdit: true, saving: false, catalogLoading: false, hostWide: false, instances: instances)
    }
    func testAdvertisedOneMLabelsAreIncludedWithoutInventingToggle() throws {
        let instances = try captured()
        let catalog = ModelFamilyPolicy.catalog(from: instances, selection: .init(instanceId: "cursor", model: "gpt-5.6-sol-high"))
        let sol = try XCTUnwrap(catalog.families.first { $0.key == "gpt-5.6-sol" })
        let cursor = try XCTUnwrap(sol.sources.first { $0.instanceId == "cursor" })
        XCTAssertEqual(ModelFamilyPolicy.contextClaim(for: cursor.variants), .included)
        let gpt55 = try XCTUnwrap(catalog.families.first { $0.key == "gpt-5.5" })
        let mixed = try XCTUnwrap(gpt55.sources.first { $0.instanceId == "cursor" })
        XCTAssertEqual(ModelFamilyPolicy.contextClaim(for: mixed.variants), .none)
    }
    func testEffortOnlyDraftIsNotResetByCatalogRefresh() throws {
        let instances = try captured()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "medium")
        let changed = try XCTUnwrap(ModelPickerDraftPolicy.setEffort("high", draft: make(opened, instances), instances: instances))
        XCTAssertFalse(ModelPickerDraftPolicy.cancelDiscardsWithoutPatch(draft: changed, openedWith: opened))
        XCTAssertNil(block(changed, instances))
    }
    func testPendingDifferentFamilyCannotProduceOldModelPatch() throws {
        let instances = try captured()
        var draft = make(.init(instanceId: "codex", model: "gpt-5.6-sol"), instances)
        draft = try XCTUnwrap(ModelPickerDraftPolicy.selectFamily("gpt-5.6-terra", draft: draft, instances: instances))
        draft.familyKey = "claude-sonnet-5"
        XCTAssertEqual(block(draft, instances), .invalid)
        XCTAssertNil(ModelPickerDraftPolicy.patch(from: draft, instances: instances))
    }
    func testReadOnlySourceCannotBeAppliedEvenWhenOnline() throws {
        var instances = try captured()
        let selection = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "medium")
        var draft = make(selection, instances)
        draft = try XCTUnwrap(ModelPickerDraftPolicy.setEffort("high", draft: draft, instances: instances))
        let index = try XCTUnwrap(instances.firstIndex { $0.instanceId == "codex" })
        instances[index].modelSelectable = false
        XCTAssertEqual(block(draft, instances), .invalid)
    }
    func testOpeningEncodedModelPreservesExistingSeparateEffortWithoutWriting() throws {
        let instances = try captured()
        let opened = ModelSelection(instanceId: "cursor", model: "gpt-5.6-sol-high", effort: "high")
        let draft = make(opened, instances)
        XCTAssertEqual(block(draft, instances), .unchanged)
        XCTAssertEqual(ModelPickerDraftPolicy.resolvedSelection(draft: draft, instances: instances), opened)
    }
    func testMovingToEncodedSourceClearsObsoleteIndependentEffort() throws {
        let instances = try captured()
        let opened = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "high")
        let draft = try XCTUnwrap(ModelPickerDraftPolicy.selectSource("cursor", familyKey: "gpt-5.6-sol", draft: make(opened, instances), instances: instances))
        XCTAssertEqual(ModelPickerDraftPolicy.patch(from: draft, instances: instances)?.effort, .clear)
    }
    func testClaudeFeaturedPrioritizesCurrentNativeFamiliesNotAncientAlphabeticalRows() throws {
        let instances = try captured()
        let selection = ModelSelection(instanceId: "claude", model: "claude-sonnet-5")
        let catalog = ModelFamilyPolicy.catalog(from: instances, selection: selection)
        let featured = ModelFamilyPolicy.featuredFamilies(catalog.families.filter { $0.providerId == "claude" }, selection: selection, limit: 4)
        XCTAssertEqual(Set(featured.map(\.key)), Set(["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-haiku-4-5"]))
    }

    func testUnavailableUnchangedModelIsRetainedWithoutFalseInvalidError() throws {
        var instances = try captured()
        let selection = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol", effort: "medium")
        let index = try XCTUnwrap(instances.firstIndex { $0.instanceId == "codex" })
        instances[index].snapshot = ProviderSnapshot(state: "unavailable", reason: "Offline", authenticated: nil, version: nil)
        XCTAssertEqual(block(make(selection, instances), instances), .unchanged)
    }
    func testAdvancedRawVariantStaysOnSelectedFamilyAndSource() throws {
        let instances = try captured()
        let selection = ModelSelection(instanceId: "cursor", model: "claude-opus-5-thinking-high")
        let draft = make(selection, instances)
        let next = try XCTUnwrap(ModelPickerDraftPolicy.selectRawVariant("claude-opus-5-thinking-max-fast", draft: draft, instances: instances))
        XCTAssertEqual(next.instanceId, "cursor")
        XCTAssertEqual(next.modelId, "claude-opus-5-thinking-max-fast")
        XCTAssertEqual(next.openedWith, selection)
        XCTAssertNil(ModelPickerDraftPolicy.selectRawVariant("gpt-5.6-sol-high", draft: draft, instances: instances))
    }
    func testUnknownSuffixesDoNotRewriteUnrelatedModelIdentity() {
        XCTAssertEqual(ModelFamilyPolicy.parse("custom-company-model-high-fast").familyKey, "custom-company-model-high-fast")
        XCTAssertEqual(ModelFamilyPolicy.parse("provider/gpt-model-high").familyKey, "provider/gpt-model-high")
    }
}
