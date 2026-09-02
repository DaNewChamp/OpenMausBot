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

/// Appearance choices retained on the phone while an older paired server is
/// upgraded. Values are deliberately scoped by the owning bot's stable id;
/// the app persists the containing map under the paired connection id so a
/// different computer can never inherit an earlier computer's pending style.
public struct BotAppearanceOverride: Codable, Equatable, Sendable {
    public var color: String?
    public var mascotShape: MascotShape?
    public var avatarUrl: String?
    public var avatarCrop: AvatarCrop?

    public init(
        color: String? = nil,
        mascotShape: MascotShape? = nil,
        avatarUrl: String? = nil,
        avatarCrop: AvatarCrop? = nil
    ) {
        self.color = color
        self.mascotShape = mascotShape
        self.avatarUrl = avatarUrl
        self.avatarCrop = avatarCrop
    }

    public var isEmpty: Bool {
        color == nil && mascotShape == nil && avatarUrl == nil && avatarCrop == nil
    }
}

/// Bounded device-local appearance overrides. These are a compatibility
/// buffer, not a second source of truth: whenever the server echoes a
/// pending value, the corresponding entry is removed.
public struct BotAppearanceOverrides: Codable, Equatable, Sendable {
    public static let maxEntries = 128

    private var values: [String: BotAppearanceOverride]

    public init(values: [String: BotAppearanceOverride] = [:]) {
        self.values = values
        trim()
    }

    public var count: Int { values.count }
    public var entries: [String: BotAppearanceOverride] { values }

    public func value(for stableID: String) -> BotAppearanceOverride? {
        values[stableID]
    }

    public mutating func set(_ override: BotAppearanceOverride, for stableID: String) {
        guard !override.isEmpty else {
            values.removeValue(forKey: stableID)
            return
        }
        values[stableID] = override
        trim(preserving: stableID)
    }

    public mutating func remove(for stableID: String) {
        values.removeValue(forKey: stableID)
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

    /// Roster snippet: one flow of prose, no Markdown headings or quote prefixes.
    public static func rosterPreview(_ raw: String) -> String {
        let lines = raw.split(whereSeparator: \.isNewline).map {
            var line = $0.trimmingCharacters(in: .whitespaces)
            while line.hasPrefix("#") {
                line.removeFirst()
                line = line.trimmingCharacters(in: .whitespaces)
            }
            while line.hasPrefix(">") {
                line.removeFirst()
                line = line.trimmingCharacters(in: .whitespaces)
            }
            line = line.replacingOccurrences(of: "**", with: "")
            line = line.replacingOccurrences(of: "__", with: "")
            line = line.replacingOccurrences(of: "`", with: "")
            return line
        }.filter { !$0.isEmpty }
        return String(lines.joined(separator: " ").prefix(180))
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
    /// roster policy. Bot⇄bot channels stay hidden unless `showBotChannels`.
    func conversationSummaries(showBotChannels: Bool = false) -> [ConversationSummary] {
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

        let roomSummaries = BotChannelPolicy.rosterRooms(rooms, showBotChannels: showBotChannels).map { room in
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
        case .text: return ConversationSummary.rosterPreview(last.text ?? "")
        case .options:
            guard let card = last.card else { return "" }
            return card.isPending && !card.subtitle.isEmpty ? card.subtitle : card.title
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        case .connector:
            guard let connector = last.connector, connector.isUsable else { return last.text ?? "" }
            return connector.label
        case .unknown: return last.text ?? ""
        }
    }
}
