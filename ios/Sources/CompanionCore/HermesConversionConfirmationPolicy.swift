import Foundation

public struct HermesConversionConfirmationCopy: Equatable, Sendable {
    public let summary: String
    public let onlyThisBot: String
    public let preserved: String

    public init(summary: String, onlyThisBot: String, preserved: String) {
        self.summary = summary
        self.onlyThisBot = onlyThisBot
        self.preserved = preserved
    }
}

/// User-facing Hermes conversion confirmation shared by profile and chat model
/// pickers. Conversion is never applied directly from endpoint selection.
public enum HermesConversionConfirmationPolicy: Sendable {
    public static let preservedSummary =
        "Name, avatar, rooms, and history stay. Hierarchy, unread state, pins, policies, and fleet grants stay."

    public static let onlyThisBotChanges = "Only this bot changes."

    public static let contextHandoffTitle = "Context handoff"
    public static let contextHandoffDetail =
        "Optionally include a short sanitized summary of recent conversation context. Credentials and raw tool output are never sent."

    public static func confirmationCopy(
        botName: String,
        computerName: String,
        profile: String
    ) -> HermesConversionConfirmationCopy {
        let destination = HermesRuntimePresentationPolicy.endpointLabel(
            computerName: computerName,
            profile: profile
        )
        return HermesConversionConfirmationCopy(
            summary: "Convert \(botName) to Hermes on \(destination).",
            onlyThisBot: onlyThisBotChanges,
            preserved: preservedSummary
        )
    }

    public static func requiresConfirmationBeforeApply(fromModelPicker: Bool) -> Bool {
        fromModelPicker
    }

    /// Endpoint taps in chat/profile model pickers only update draft UI state.
    public static func shouldPersistDefaultOnEndpointSelection() -> Bool { false }

    /// Runtime rebind is never triggered from endpoint selection alone.
    public static func shouldApplyRuntimeOnEndpointSelection() -> Bool { false }

    /// Cancel dismisses draft selection; persisted default and bot binding stay.
    public static func draftEndpointAfterCancel() -> HermesEndpointOption? { nil }

    /// Per-bot conversion does not rewrite the global default for new Hermes bots.
    public static func shouldPersistDefaultOnConfirmedConversion() -> Bool { false }

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
