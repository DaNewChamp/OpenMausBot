// Which face a bot wears — the desktop's `stateForBot`, ported.
//
// A pinned expression wins; then what the bot is doing right now; then a
// guess from its role. Same rules, same order, so a bot looks the same on
// the phone as on the laptop.
import Foundation
import CompanionCore

extension MausState {
    /// The desktop's legacy names, kept so an older bot record still resolves.
    private static let legacy: [String: MausState] = [
        "deadpan": .idle, "friendly": .happy, "focused": .working, "thinking": .thinking,
        "excited": .excited, "sleepy": .drowsy, "surprised": .surprised, "skeptical": .suspicious,
        "worried": .scared, "mischievous": .playful,
    ]

    /// Resolves any stored value — current, legacy or junk — to a real state.
    static func normalize(_ value: String?) -> MausState? {
        guard let value, !value.isEmpty else { return nil }
        return MausState(rawValue: value) ?? legacy[value]
    }

    static func forBot(_ bot: Bot, last: Message?) -> MausState {
        // Runtime activity outranks a stored expression. A bot that is
        // working should move; a bot waiting for a person or a dead runtime
        // should remain still even if an old expression was "thinking".
        if let activity = bot.activity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !activity.isEmpty {
            switch activity {
            case "working": return .working
            case "waiting-on-you": return .curious
            case "no-signal": return .alerting
            case "dead": return .sad
            case "idle": break
            default: break
            }
        } else if bot.busy == true {
            // Older servers only sent the derived busy flag.
            return .working
        }

        if let pinned = normalize(bot.mascotExpression) { return pinned }

        if last?.kind == .activity, last?.tool?.ok == false { return .alerting }
        if bot.unread { return .notifying }
        if last?.kind == .options { return .curious }

        let profile = "\(bot.name) \(bot.title) \(bot.description)".lowercased()
        func matches(_ words: [String]) -> Bool {
            words.contains { word in
                profile.range(of: "\\b\(NSRegularExpression.escapedPattern(for: word))\\b", options: .regularExpression) != nil
            }
        }
        // Role words describe a bot's specialty, not what it is doing now.
        // Keeping them out of the activity states prevents an idle coding or
        // research bot from animating in the roster.
        if matches(["code", "coding", "developer", "development", "engineer", "engineering", "build", "debug", "program", "software"]) { return .idle }
        if matches(["research", "researcher", "search", "investigate", "strategy", "strategist", "study", "learn", "knowledge"]) { return .idle }
        if matches(["marketing", "growth", "launch", "campaign", "social", "sales", "outreach", "brand"]) { return .excited }
        if matches(["overnight", "night", "background", "async", "queue", "batch", "long-running"]) { return .drowsy }
        if matches(["monitor", "monitoring", "incident", "alert", "watch", "status", "uptime"]) { return .radar }
        if matches(["review", "reviewer", "audit", "critic", "critique", "quality", "qa", "test", "legal"]) { return .suspicious }
        if matches(["security", "secure", "compliance", "risk", "privacy", "finance", "financial"]) { return .scared }
        if matches(["design", "designer", "creative", "brainstorm", "art", "illustration", "music", "story"]) { return .playful }
        if matches(["support", "help", "success", "onboarding", "coach", "teacher", "guide", "welcome"]) { return .happy }
        return .idle
    }

    /// The face for a chat as a whole: a bot's own, a room's is "happy" —
    /// which is what the desktop draws for room avatars.
    static func forChat(_ chat: Chat, in state: CompanionState) -> MausState {
        switch chat {
        case let .bot(bot): return forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
        case let .room(room):
            // A room's busyBotId is the authoritative owner of its current
            // turn. If that member is waiting on a person, keep the group
            // still; if an older payload has no member record, busy remains a
            // safe indication that something is running.
            guard room.busyBotId != nil else { return .happy }
            guard let ownerID = room.busyBotId, let owner = state.bot(ownerID) else { return .working }
            return owner.isWorking ? .working : .curious
        }
    }
}
