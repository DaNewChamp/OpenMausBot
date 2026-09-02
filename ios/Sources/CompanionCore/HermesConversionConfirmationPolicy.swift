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

    /// Endpoint taps in chat/profile model pickers only update draft UI state.
    public static func shouldPersistDefaultOnEndpointSelection() -> Bool { false }

    /// Runtime rebind is never triggered from endpoint selection alone.
    public static func shouldApplyRuntimeOnEndpointSelection() -> Bool { false }

    /// Cancel dismisses draft selection; persisted default and bot binding stay.
    public static func draftEndpointAfterCancel() -> HermesEndpointOption? { nil }

    public static func shouldPersistDefaultOnConfirmedConversion() -> Bool { true }

    public static func endpointForConfirmedConversion(
        draft: HermesEndpointOption?,
        persistedDefault: HermesEndpointOption?
    ) -> HermesEndpointOption? {
        draft ?? persistedDefault
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
