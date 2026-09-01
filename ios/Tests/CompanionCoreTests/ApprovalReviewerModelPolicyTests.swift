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

    func testSectionCopyClarifiesAdvisoryRole() {
        XCTAssertEqual(ApprovalReviewerModelPolicy.sectionTitle, "Approval summary model")
        XCTAssertTrue(ApprovalReviewerModelPolicy.sectionExplanation.contains("executive summary"))
        XCTAssertTrue(ApprovalReviewerModelPolicy.sectionExplanation.contains("never approves"))
        XCTAssertTrue(ApprovalReviewerModelPolicy.sectionExplanation.contains("main reasoning"))
    }
}
