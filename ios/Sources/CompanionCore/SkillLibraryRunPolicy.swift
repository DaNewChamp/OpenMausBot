import Foundation

/// How a library skill is invoked from the phone. The HUD's default path
/// submits a natural-language command as a chat message; the library Run
/// action uses the same text so both surfaces hit one send path.
public enum SkillLibraryRunPolicy: Sendable {
    public static func command(name: String) -> String {
        "Use the \(name) skill"
    }

    public static func command(for skill: BotSkill) -> String {
        command(name: skill.name)
    }

    public static func visibleDescription(_ description: String?) -> String? {
        let trimmed = description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
