import Foundation

/// Device-local pin choices used when a paired server predates the pin route.
/// The map is intentionally small and deterministic: it is a UI fallback,
/// not a second server-side conversation database.
public struct ConversationPinOverrides: Codable, Equatable, Sendable {
    public static let maxEntries = 128

    private var values: [String: Bool]

    public init(values: [String: Bool] = [:]) {
        self.values = values
        trim()
    }

    public var count: Int { values.count }

    public func value(for stableID: String) -> Bool? {
        values[stableID]
    }

    public mutating func set(_ pinned: Bool, for stableID: String) {
        values[stableID] = pinned
        trim(preserving: stableID)
    }

    public mutating func remove(for stableID: String) {
        values.removeValue(forKey: stableID)
    }

    /// A server response containing a pin field is authoritative. An omitted
    /// field means this is an older server and the local choice remains.
    public mutating func reconcile(serverPinned: Bool?, for stableID: String) {
        guard serverPinned != nil else { return }
        remove(for: stableID)
    }

    private mutating func trim(preserving stableID: String? = nil) {
        guard values.count > Self.maxEntries else { return }
        for candidate in values.keys.sorted() where values.count > Self.maxEntries {
            if candidate != stableID { values.removeValue(forKey: candidate) }
        }
    }
}

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
                    pinned: bot.pinned ?? pinnedOverrides.value(for: "bot:\(bot.id)") ?? false,
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
                pinned: room.pinned ?? pinnedOverrides.value(for: "room:\(room.id)") ?? false,
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
