import Foundation

/// Phone-side copy of `src/lib/group-routing.ts`. The server still decides
/// who actually speaks; this is what the composer uses to insert @mentions
/// and to hint who will answer.
public enum GroupRouting {
    public struct Member: Equatable, Sendable {
        public var id: String
        public var name: String
        public var hidden: Bool
        public var color: String

        public init(id: String, name: String, hidden: Bool = false, color: String = "blue") {
            self.id = id
            self.name = name
            self.hidden = hidden
            self.color = color
        }
    }

    public static func effectiveDefaultResponder(
        _ responder: GroupResponder,
        members: [Member]
    ) -> GroupResponder {
        let available = visible(members)
        switch responder.kind {
        case "everyone", "mentions":
            return responder
        case "member":
            if let botId = responder.botId, available.contains(where: { $0.id == botId }) {
                return responder
            }
            fallthrough
        default:
            if let first = available.first {
                return GroupResponder(kind: "member", botId: first.id)
            }
            return GroupResponder(kind: "mentions", botId: nil)
        }
    }

    public static func groupComposerHint(room: Room, members: [Member]) -> String {
        if room.dm == true { return "continue the conversation" }
        let value = effectiveDefaultResponder(room.defaultResponder, members: members)
        switch value.kind {
        case "everyone":
            return "everyone responds"
        case "mentions":
            return "@mention a bot"
        default:
            let name = members.first { $0.id == value.botId }?.name ?? "Lead"
            return "\(name) responds"
        }
    }

    public static func groupResponseHint(room: Room, members: [Member]) -> String {
        if room.dm == true { return "Reply here to continue the bot-to-bot conversation." }
        let value = effectiveDefaultResponder(room.defaultResponder, members: members)
        switch value.kind {
        case "everyone":
            return "Everyone responds unless you @mention specific bots."
        case "mentions":
            return "Mention a bot with @ to bring them in."
        default:
            let name = members.first { $0.id == value.botId }?.name ?? "The lead bot"
            return "\(name) responds by default. @mention someone else to choose them instead."
        }
    }

    public static func roomRespondersForComposer(
        text: String,
        members: [Member],
        responder: GroupResponder
    ) -> [Member] {
        let available = visible(members)
        if matchesEveryone(in: text) { return available }
        let mentioned = mentionedMembers(in: text, members: available)
        if !mentioned.isEmpty { return mentioned }
        let fallback = effectiveDefaultResponder(responder, members: available)
        switch fallback.kind {
        case "everyone":
            return available
        case "member":
            return available.filter { $0.id == fallback.botId }
        default:
            return []
        }
    }

    /// Trailing `@query` with no whitespace after the @. Nil when the draft
    /// is not currently composing a mention.
    public static func activeMentionQuery(in draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex {
            let before = draft[draft.index(before: at)]
            if !before.isWhitespace { return nil }
        }
        let rest = draft[draft.index(after: at)...]
        if rest.contains(where: \.isWhitespace) { return nil }
        return String(rest)
    }

    public static func mentionCandidates(query: String, members: [Member]) -> [Member] {
        let available = visible(members)
        let needle = query.lowercased()
        let filtered: [Member]
        if needle.isEmpty {
            filtered = available
        } else {
            filtered = available.filter { $0.name.lowercased().hasPrefix(needle) }
        }
        return filtered.sorted { lhs, rhs in
            let left = lhs.name.lowercased()
            let right = rhs.name.lowercased()
            if left == needle, right != needle { return true }
            if right == needle, left != needle { return false }
            if left.hasPrefix(needle), !right.hasPrefix(needle) { return true }
            if right.hasPrefix(needle), !left.hasPrefix(needle) { return false }
            if left != right { return left < right }
            return lhs.id < rhs.id
        }
    }

    public static func applyingMention(_ name: String, to draft: String) -> String {
        guard let at = draft.lastIndex(of: "@") else {
            return draft.hasSuffix(" ") || draft.isEmpty ? draft + "@\(name) " : draft + " @\(name) "
        }
        let prefix = draft[..<at]
        return "\(prefix)@\(name) "
    }

    public static func mentionedMembers(in text: String, members: [Member]) -> [Member] {
        let candidates = visible(members)
            .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.name.count > $1.name.count }
        let lower = text.lowercased()
        var found: [Member] = []
        var searchStart = lower.startIndex
        while searchStart < lower.endIndex,
              let at = lower[searchStart...].firstIndex(of: "@") {
            let atOffset = lower.distance(from: lower.startIndex, to: at)
            if atOffset > 0 {
                let before = text[text.index(text.startIndex, offsetBy: atOffset - 1)]
                if !before.isWhitespace {
                    searchStart = lower.index(after: at)
                    continue
                }
            }
            let afterAt = lower.index(after: at)
            let rest = lower[afterAt...]
            if let hit = candidates.first(where: { member in
                let name = member.name.lowercased()
                guard rest.hasPrefix(name) else { return false }
                let afterName = rest.index(rest.startIndex, offsetBy: name.count)
                if afterName == rest.endIndex { return true }
                return !rest[afterName].isLetter && !rest[afterName].isNumber
            }), !found.contains(where: { $0.id == hit.id }) {
                found.append(hit)
            }
            searchStart = lower.index(after: at)
        }
        return found
    }

    public static func matchesEveryone(in text: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: #"(?:^|\s)@everyone\b"#, options: [.caseInsensitive]) else {
            return false
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }

    private static func visible(_ members: [Member]) -> [Member] {
        members.filter { !$0.hidden }
    }
}
