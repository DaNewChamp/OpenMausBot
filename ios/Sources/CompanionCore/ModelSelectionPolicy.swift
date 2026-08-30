import Foundation

/// Busy-turn rules for engine/model selection. The catalog itself stays
/// whatever the harness advertised — this only gates *when* a switch is
/// allowed, never which providers appear.
public enum ModelSelectionPolicy: Sendable {
    public static let busyExplanation = "Interrupt this agent before switching models."
    public static let idleHint = "Changes apply to the next message."

    public static func allowsSwitch(
        working: Bool,
        saving: Bool = false,
        catalogLoading: Bool = false
    ) -> Bool {
        !working && !saving && !catalogLoading
    }

    public static func footerHint(working: Bool) -> String {
        working ? busyExplanation : idleHint
    }
}
