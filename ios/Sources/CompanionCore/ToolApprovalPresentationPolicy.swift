import Foundation

public struct ToolApprovalPresentation: Equatable, Sendable {
    public var headline: String
    public var changeDescription: String
    public var isReadOnly: Bool
    public var rawTool: String
    public var rawCommand: String
    public var scope: String
    public var detailsText: String

    public init(
        headline: String,
        changeDescription: String,
        isReadOnly: Bool,
        rawTool: String,
        rawCommand: String,
        scope: String,
        detailsText: String
    ) {
        self.headline = headline
        self.changeDescription = changeDescription
        self.isReadOnly = isReadOnly
        self.rawTool = rawTool
        self.rawCommand = rawCommand
        self.scope = scope
        self.detailsText = detailsText
    }
}

public enum ToolApprovalPresentationPolicy: Sendable {
    /// Pure presentation calculation for a tool approval card.
    public static func presentation(actor: String, card: OptionCard) -> ToolApprovalPresentation {
        let hl = headline(actor: actor, card: card)
        let cd = changeDescription(for: card)
        let ro = isReadOnly(card)
        let rt = rawTool(for: card)
        let rc = rawCommand(for: card)
        let sc = scope(for: card)
        let dt = details(for: card)
        return ToolApprovalPresentation(
            headline: hl,
            changeDescription: cd,
            isReadOnly: ro,
            rawTool: rt,
            rawCommand: rc,
            scope: sc,
            detailsText: dt
        )
    }

    /// Compact card headline communicating actor / action / host.
    public static func headline(actor: String, card: OptionCard) -> String {
        let effectiveActor: String = {
            let trimmed = actor.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
            if let titleActor = extractActorFromTitle(card.title) { return titleActor }
            return "Bot"
        }()

        let host = card.hostLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeHost = (host != nil && !host!.isEmpty) ? host! : "this computer"

        // 1. If card.details is a concise single-line command (<= 40 chars), e.g. "git status" or "rm -rf ./build"
        let rawCmd = (card.details ?? card.subtitle).trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawCmd.isEmpty && !rawCmd.contains("\n") && rawCmd.count <= 40 && isCommandLineTool(card) {
            let cleanCmd = OptionCard.sanitizedPresentation(rawCmd)
            if !cleanCmd.isEmpty {
                return "\(effectiveActor) wants to run \(cleanCmd) on \(safeHost)"
            }
        }

        // 2. If actionSummary is present
        if let summary = card.actionSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
            let sanitized = OptionCard.sanitizedPresentation(summary)
            if sanitized.lowercased().hasPrefix("run ") {
                let lower = sanitized.prefix(1).lowercased() + sanitized.dropFirst()
                if lower.localizedCaseInsensitiveContains(" on ") {
                    return "\(effectiveActor) wants to \(lower)"
                } else {
                    return "\(effectiveActor) wants to \(lower) on \(safeHost)"
                }
            } else if sanitized.lowercased().hasPrefix("use ") {
                let lower = sanitized.prefix(1).lowercased() + sanitized.dropFirst()
                if lower.localizedCaseInsensitiveContains(" on ") {
                    return "\(effectiveActor) wants to \(lower)"
                } else {
                    return "\(effectiveActor) wants to \(lower) on \(safeHost)"
                }
            } else if sanitized.localizedCaseInsensitiveContains(" on ") {
                return "\(effectiveActor) wants to run \(sanitized)"
            } else {
                return "\(effectiveActor) wants to \(sanitized) on \(safeHost)"
            }
        }

        // 3. Fallback based on toolLabel
        if let tool = card.toolLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !tool.isEmpty {
            let cleanTool = OptionCard.sanitizedPresentation(tool)
            if cleanTool.caseInsensitiveCompare("Computer") == .orderedSame {
                return "\(effectiveActor) wants to use the computer on \(safeHost)"
            }
            if cleanTool.caseInsensitiveCompare("Terminal") == .orderedSame {
                let readOnly = isReadOnly(card)
                return "\(effectiveActor) wants to run \(readOnly ? "a read-only command" : "a command") on \(safeHost)"
            }
            return "\(effectiveActor) wants to run \(cleanTool.lowercased()) on \(safeHost)"
        }

        let readOnly = isReadOnly(card)
        return "\(effectiveActor) wants to run \(readOnly ? "a read-only tool" : "a tool") on \(safeHost)"
    }

    /// Second line clearly stating whether the requested tool changes anything.
    public static func changeDescription(for card: OptionCard) -> String {
        if isReadOnly(card) {
            return "Does not change anything · read-only"
        }
        if let change = card.changeSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
           !change.isEmpty,
           change.caseInsensitiveCompare("Nothing; read-only") != .orderedSame {
            let sanitized = OptionCard.sanitizedPresentation(change)
            return "Changes files or system state · \(sanitized)"
        }
        if let exec = card.executiveSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
           !exec.isEmpty {
            let sanitized = OptionCard.sanitizedPresentation(exec)
            return "Changes files or system state · \(sanitized)"
        }
        return "Changes files or system state"
    }

    /// Deterministic classification of whether the card represents a read-only action.
    public static func isReadOnly(_ card: OptionCard) -> Bool {
        if let change = card.changeSummary?.trimmingCharacters(in: .whitespacesAndNewlines) {
            if change.caseInsensitiveCompare("Nothing; read-only") == .orderedSame {
                return true
            }
            if change.localizedCaseInsensitiveContains("delete") ||
                change.localizedCaseInsensitiveContains("modify") ||
                change.localizedCaseInsensitiveContains("create") ||
                change.localizedCaseInsensitiveContains("change") {
                return false
            }
        }
        if let action = card.actionSummary {
            if action.localizedCaseInsensitiveContains("read-only") {
                return true
            }
        }
        if let risk = card.riskLevel?.lowercased(), (risk == "high" || risk == "medium") {
            return false
        }
        let command = (card.details ?? card.subtitle).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if command.hasPrefix("git status") || command.hasPrefix("git log") || command.hasPrefix("git diff") ||
            command.hasPrefix("git show") || command.hasPrefix("git branch") || command.hasPrefix("ls") ||
            command.hasPrefix("pwd") || command.hasPrefix("cat ") || command.hasPrefix("head ") {
            return true
        }
        return false
    }

    /// Raw tool identity for disclosure Details.
    public static func rawTool(for card: OptionCard) -> String {
        let tool = card.tool ?? card.toolLabel ?? "unknown"
        return OptionCard.sanitizedPresentation(tool)
    }

    /// Raw command or argument for disclosure Details.
    public static func rawCommand(for card: OptionCard) -> String {
        let cmd = card.details ?? card.subtitle
        return OptionCard.sanitizedPresentation(cmd)
    }

    /// Scope of the action or grant for disclosure Details.
    public static func scope(for card: OptionCard) -> String {
        if let allowKey = card.allowKey, !allowKey.isEmpty {
            if let host = card.hostLabel, !host.isEmpty {
                return "\(host) (\(allowKey))"
            }
            return allowKey
        }
        if let host = card.hostLabel, !host.isEmpty {
            return host
        }
        if let res = card.resourceSummary, !res.isEmpty {
            return OptionCard.sanitizedPresentation(res)
        }
        return "local"
    }

    /// Formatted Details revealing raw tool / command / scope.
    public static func details(for card: OptionCard) -> String {
        let tool = rawTool(for: card)
        let cmd = rawCommand(for: card)
        let sc = scope(for: card)

        var lines: [String] = []
        lines.append("Tool: \(tool)")
        if !cmd.isEmpty {
            lines.append("Command: \(cmd)")
        }
        lines.append("Scope: \(sc)")
        return lines.joined(separator: "\n")
    }

    private static func isCommandLineTool(_ card: OptionCard) -> Bool {
        if let toolLabel = card.toolLabel, toolLabel.caseInsensitiveCompare("Terminal") == .orderedSame {
            return true
        }
        if let tool = card.tool?.lowercased() {
            return tool.contains("terminal") || tool.contains("bash") || tool.contains("shell") || tool.contains("bridge") || tool.contains("ssh")
        }
        return false
    }

    private static func extractActorFromTitle(_ title: String) -> String? {
        let sanitized = OptionCard.sanitizedPresentation(title)
        if let range = sanitized.range(of: " needs your approval", options: .caseInsensitive) {
            let actor = String(sanitized[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !actor.isEmpty { return actor }
        }
        if let range = sanitized.range(of: " wants to", options: .caseInsensitive) {
            let actor = String(sanitized[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !actor.isEmpty { return actor }
        }
        return nil
    }
}
