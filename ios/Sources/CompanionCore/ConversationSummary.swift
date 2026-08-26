import Foundation

/// The app-independent projection used to populate a conversation roster.
/// Keeping this beside the state fold makes ordering identical on every view
/// and gives the package tests the same policy the app renders.
public struct ConversationSummary: Identifiable, Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        case bot
        case room
    }

    public let id: String
    public let kind: Kind
    public let name: String
    public let preview: String
    public let lastActivity: Double
    public let pinned: Bool
    public let unread: Bool

    public init(
        id: String,
        kind: Kind,
        name: String,
        preview: String,
        lastActivity: Double,
        pinned: Bool,
        unread: Bool
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.preview = preview
        self.lastActivity = lastActivity
        self.pinned = pinned
        self.unread = unread
    }

    /// Pinned conversations lead, followed by unread conversations, then the
    /// most recently active. Identity is the final key so equal timestamps
    /// are deterministic rather than depending on input order.
    public static func ordered(_ summaries: [ConversationSummary]) -> [ConversationSummary] {
        summaries.sorted(by: comesBefore)
    }

    public static func comesBefore(_ left: ConversationSummary, _ right: ConversationSummary) -> Bool {
        if left.pinned != right.pinned { return left.pinned }
        if left.unread != right.unread { return left.unread }
        if left.lastActivity != right.lastActivity { return left.lastActivity > right.lastActivity }
        return left.id < right.id
    }
}

public extension CompanionState {
    /// Every visible bot and room, projected once and sorted by the shared
    /// roster policy. Views can map these records to their own presentation
    /// types without reimplementing filtering or ordering.
    var conversationSummaries: [ConversationSummary] {
        let botSummaries = bots
            .filter { $0.hidden != true }
            .map { bot in
                let last = visibleTranscript(forThread: bot.threadId).last
                return ConversationSummary(
                    id: "bot:\(bot.id)",
                    kind: .bot,
                    name: bot.name,
                    preview: Self.preview(of: last),
                    lastActivity: last?.at ?? 0,
                    pinned: bot.pinned ?? false,
                    unread: bot.unread
                )
            }

        let roomSummaries = rooms.map { room in
            let last = visibleTranscript(forThread: room.threadId).last
            return ConversationSummary(
                id: "room:\(room.id)",
                kind: .room,
                name: room.name,
                preview: Self.preview(of: last),
                lastActivity: last?.at ?? 0,
                pinned: room.pinned ?? false,
                unread: room.unread
            )
        }

        return ConversationSummary.ordered(botSummaries + roomSummaries)
    }

    private static func preview(of last: Message?) -> String {
        guard let last else { return "" }
        switch last.kind {
        case .text: return last.text ?? ""
        case .options:
            guard let card = last.card else { return "" }
            return card.isPending && !card.subtitle.isEmpty ? card.subtitle : card.title
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        case .unknown: return last.text ?? ""
        }
    }
}
