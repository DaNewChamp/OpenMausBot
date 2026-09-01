import Foundation

/// Compact, subscription-first model lists for the approval-summary reviewer.
public enum ApprovalReviewerModelPolicy: Sendable {
    public static let sectionTitle = "Approval summary model"
    public static let sectionExplanation =
        "Rewrites approval requests into a short executive summary. This never controls the bot's main reasoning and never approves or denies."

    public static func compactModels(
        providerId: String,
        models: [ApprovalReviewerModel],
        selectedModelId: String?
    ) -> [ApprovalReviewerModel] {
        guard providerId == "openai" else { return models }
        let preferred = ProviderCatalogPolicy.preferredOpenAIModelOrder
        let byId = Dictionary(uniqueKeysWithValues: models.map { ($0.id, $0) })
        var compact: [ApprovalReviewerModel] = []
        for id in preferred {
            if let model = byId[id] {
                compact.append(model)
            }
        }
        if let selectedModelId,
           !compact.contains(where: { $0.id == selectedModelId }) {
            if let orphan = byId[selectedModelId] {
                compact.append(orphan)
            } else {
                compact.append(
                    ApprovalReviewerModel(
                        id: selectedModelId,
                        label: AdvertisedModelCatalog.displayModelLabel(selectedModelId)
                    )
                )
            }
        }
        return compact.isEmpty ? models : compact
    }
}
