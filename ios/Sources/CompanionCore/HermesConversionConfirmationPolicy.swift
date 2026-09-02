import Foundation

/// User-facing Hermes conversion confirmation shared by profile and chat model
/// pickers. Conversion is never applied directly from endpoint selection.
public enum HermesConversionConfirmationPolicy: Sendable {
    public static let preservedSummary =
        "Avatar, hierarchy, rooms, transcript, unread state, pins, policies, and fleet grants stay."

    public static let contextHandoffTitle = "Context handoff"
    public static let contextHandoffDetail =
        "Optionally include a short sanitized summary of recent conversation context. Credentials and raw tool output are never sent."

    public static func requiresConfirmationBeforeApply(fromModelPicker: Bool) -> Bool {
        fromModelPicker
    }

    public static func applyRequest(
        endpoint: HermesEndpointOption,
        includeContextSummary: Bool
    ) -> HermesRuntimeRebindRequest {
        var request = HermesConversionApplyPolicy.request(from: endpoint)
        request.contextMode = includeContextSummary ? "summary" : "none"
        return request
    }
}
