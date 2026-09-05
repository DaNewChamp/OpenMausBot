import Foundation

/// Presentation and opt-out policy for hub-wide Global style.
public enum GlobalStylePresentationPolicy: Sendable {
    public static let sectionTitle = "Global style"
    public static let sectionFooter =
        "Applies to every bot unless overridden in that bot's profile instructions."
    public static let instructionsAccessibilityLabel = "Global style instructions"

    public static let optOutMarkers = ["[house-style: off]", "[global-style: off]"]

    /// Detects whether the bot's own instructions contain an explicit opt-out marker.
    public static func isOptedOut(instructions: String?) -> Bool {
        guard let instructions else { return false }
        return instructions
            .split(whereSeparator: \.isNewline)
            .contains { line in
                let trimmed = String(line).trimmingCharacters(in: CharacterSet.whitespaces)
                return trimmed.caseInsensitiveCompare("[house-style: off]") == .orderedSame
                    || trimmed.caseInsensitiveCompare("[global-style: off]") == .orderedSame
                    || trimmed.caseInsensitiveCompare("global style: off") == .orderedSame
            }
    }

    /// Strips internal opt-out markers from user-facing instructions text.
    public static func stripOptOutMarkers(from instructions: String?) -> String {
        guard let instructions else { return "" }
        let lines = instructions.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        let filtered = lines.filter { line in
            let trimmed = String(line).trimmingCharacters(in: CharacterSet.whitespaces)
            return trimmed.caseInsensitiveCompare("[house-style: off]") != .orderedSame
                && trimmed.caseInsensitiveCompare("[global-style: off]") != .orderedSame
                && trimmed.caseInsensitiveCompare("global style: off") != .orderedSame
        }
        return filtered.joined(separator: "\n").trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    /// Composes the instructions string with the appropriate opt-out marker if disabled.
    public static func composeInstructions(userText: String, applyGlobalStyle: Bool) -> String {
        let cleaned = stripOptOutMarkers(from: userText)
        if applyGlobalStyle {
            return cleaned
        } else {
            return cleaned.isEmpty ? "[house-style: off]" : "\(cleaned)\n[house-style: off]"
        }
    }

    /// Returns whether global style effectively applies to this bot.
    public static func applies(config: ConfigStatus?, instructions: String?) -> Bool {
        guard config?.houseStyle?.enabled ?? true else { return false }
        return !isOptedOut(instructions: instructions)
    }

    /// Human-readable explanation of whether global style applies to the bot.
    public static func statusDescription(config: ConfigStatus?, instructions: String?) -> String {
        if config?.houseStyle?.enabled == false {
            return "Global style is turned off in Settings."
        }
        if isOptedOut(instructions: instructions) {
            return "Global style is turned off for this bot."
        }
        return "Global style applies to this bot."
    }
}
