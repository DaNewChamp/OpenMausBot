import XCTest
@testable import CompanionCore

final class ApprovalReviewerModelPolicyTests: XCTestCase {
    private func reviewerModel(_ id: String, label: String? = nil) -> ApprovalReviewerModel {
        ApprovalReviewerModel(id: id, label: label ?? id)
    }

    func testOpenAIReviewerListUsesPreferredOrder() {
        let compact = ApprovalReviewerModelPolicy.compactModels(
            providerId: "openai",
            models: [
                reviewerModel("gpt-5.4", label: "GPT-5.4"),
                reviewerModel("gpt-5.6-luna", label: "GPT-5.6 Luna"),
                reviewerModel("gpt-5.6-sol", label: "GPT-5.6 Sol"),
                reviewerModel("codex-old", label: "Codex Old"),
            ],
            selectedModelId: "gpt-5.6-sol"
        )
        XCTAssertEqual(compact.map(\.id), ["gpt-5.6-sol", "gpt-5.6-luna"])
    }

    func testPreservesOutOfBandSelectionAtEnd() {
        let compact = ApprovalReviewerModelPolicy.compactModels(
            providerId: "openai",
            models: [reviewerModel("gpt-5.6-sol")],
            selectedModelId: "gpt-4.1"
        )
        XCTAssertEqual(compact.map(\.id), ["gpt-5.6-sol", "gpt-4.1"])
    }

    func testNonOpenAIProvidersPassThrough() {
        let models = [reviewerModel("llama"), reviewerModel("mixtral")]
        let compact = ApprovalReviewerModelPolicy.compactModels(
            providerId: "openrouter",
            models: models,
            selectedModelId: "mixtral"
        )
        XCTAssertEqual(compact, models)
    }

    func testSectionCopyClarifiesAdvisoryRoleWithoutExposingProviderOrModel() {
        XCTAssertEqual(ApprovalReviewerModelPolicy.sectionTitle, "Explain tool requests")
        XCTAssertFalse(ApprovalReviewerModelPolicy.sectionTitle.localizedCaseInsensitiveContains("model"))
        XCTAssertFalse(ApprovalReviewerModelPolicy.sectionTitle.localizedCaseInsensitiveContains("provider"))
        XCTAssertFalse(ApprovalReviewerModelPolicy.sectionExplanation.localizedCaseInsensitiveContains("provider"))
        XCTAssertTrue(ApprovalReviewerModelPolicy.sectionExplanation.contains("never approves"))
        XCTAssertTrue(ApprovalReviewerModelPolicy.sectionExplanation.contains("main reasoning"))
    }

    func testPatchPreservesExistingReviewerSelection() {
        let status = ApprovalReviewerStatus(
            mode: .whenUnclear,
            selection: ApprovalReviewerSelection(instanceId: "openai", model: "gpt-5.4"),
            providers: []
        )

        let alwaysPatch = ApprovalReviewerModelPolicy.patch(mode: .always, preserving: status)
        XCTAssertEqual(alwaysPatch.mode, .always)
        XCTAssertEqual(alwaysPatch.instanceId, "openai")
        XCTAssertEqual(alwaysPatch.model, "gpt-5.4")

        let offPatch = ApprovalReviewerModelPolicy.patch(mode: .off, preserving: status)
        XCTAssertEqual(offPatch.mode, .off)
        XCTAssertEqual(offPatch.instanceId, "openai")
        XCTAssertEqual(offPatch.model, "gpt-5.4")
    }

    func testPatchOmitsSelectionWhenNoneConfigured() {
        let statusWithoutSelection = ApprovalReviewerStatus(
            mode: .whenUnclear,
            selection: nil,
            providers: []
        )

        let patch = ApprovalReviewerModelPolicy.patch(mode: .whenUnclear, preserving: statusWithoutSelection)
        XCTAssertEqual(patch.mode, .whenUnclear)
        XCTAssertNil(patch.instanceId)
        XCTAssertNil(patch.model)

        let nilStatusPatch = ApprovalReviewerModelPolicy.patch(mode: .off, preserving: nil)
        XCTAssertEqual(nilStatusPatch.mode, .off)
        XCTAssertNil(nilStatusPatch.instanceId)
        XCTAssertNil(nilStatusPatch.model)
    }
}
