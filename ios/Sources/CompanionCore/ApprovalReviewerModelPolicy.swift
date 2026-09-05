import Foundation

/// Policy for approval request explanations and reviewer model configuration.
public enum ApprovalReviewerModelPolicy: Sendable {
    public static let sectionTitle = "Explain tool requests"
    public static let sectionExplanation =
        "Explains approval requests in plain language. This never controls the bot's main reasoning and never approves or denies."

    /// Builds an update patch for approval reviewer mode, preserving any configured
    /// provider and model choices so simplifying the UI does not erase server config.
    public static func patch(
        mode: ApprovalReviewerMode,
        preserving status: ApprovalReviewerStatus?
    ) -> ApprovalReviewerPatch {
        ApprovalReviewerPatch(
            mode: mode,
            instanceId: status?.selection?.instanceId,
            model: status?.selection?.model
        )
    }

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
