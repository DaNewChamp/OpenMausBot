import Foundation

/// Auto-created bot⇄bot channels share one canonical transcript in a `dm`
/// room. They stay out of the main roster unless the user opts in.
public enum BotChannelPolicy {
    public struct Perspective: Equatable, Sendable {
        public var roomId: String
        public var botId: String

        public init(roomId: String, botId: String) {
            self.roomId = roomId
            self.botId = botId
        }
    }

    public static func isBotChannel(_ room: Room) -> Bool {
        room.dm == true
    }

    public static func rosterRooms(_ rooms: [Room], showBotChannels: Bool) -> [Room] {
        guard !showBotChannels else { return rooms }
        return rooms.filter { !isBotChannel($0) }
    }

    /// Ordered participant ids for a two-bot channel, putting the invoking bot
    /// first when the user opens the room from that bot's chat.
    public static func participantOrder(
        memberIds: [String],
        invokingBotId: String?
    ) -> [String] {
        guard memberIds.count == 2, let invokingBotId, memberIds.contains(invokingBotId) else {
            return memberIds
        }
        return [invokingBotId, memberIds.first { $0 != invokingBotId }!]
    }

    /// Chrome title when a scoped perspective matches this room.
    public static func perspectiveTitle(
        room: Room,
        perspective: Perspective?,
        botName: (String) -> String?
    ) -> String? {
        guard isBotChannel(room),
              let perspective,
              perspective.roomId == room.id,
              let lead = botName(perspective.botId),
              let otherId = room.memberIds.first(where: { $0 != perspective.botId }),
              let other = botName(otherId)
        else { return nil }
        return "\(lead) ⇄ \(other)"
    }

    /// Drop a stale perspective when opening a different room or leaving channels.
    public static func clearedPerspective(
        current: Perspective?,
        openingRoomId: String?
    ) -> Perspective? {
        guard let current else { return nil }
        if openingRoomId == current.roomId { return current }
        return nil
    }

    public enum NavigationAction: Equatable, Sendable {
        case openDedicatedReadOnly(perspectiveBotId: String)
        case showParticipantPicker
        case openSharedRoom(perspectiveBotId: String)
        case unavailable
    }

    /// Dedicated 1:1 bot transcripts keep ordinary bubbles; the compact
    /// Messaged caption lives only on the parent chat indicator.
    public static let dedicatedTranscriptUsesNormalBubbles = true

    public static func isDedicatedReadOnlyConversation(_ room: Room) -> Bool {
        isBotChannel(room) && room.memberIds.count == 2
    }

    public static func showsParticipantPicker(room: Room) -> Bool {
        isBotChannel(room) && room.memberIds.count > 2
    }

    public static func hidesComposer(for room: Room) -> Bool {
        isDedicatedReadOnlyConversation(room)
    }

    public static func navigationAction(
        room: Room?,
        invokingBotId: String?,
        counterpartBotId: String
    ) -> NavigationAction {
        guard let room else { return .unavailable }
        let perspective = perspectiveBotId(
            memberIds: room.memberIds,
            invokingBotId: invokingBotId,
            counterpartBotId: counterpartBotId
        )
        if isBotChannel(room) {
            if room.memberIds.count == 2 {
                return .openDedicatedReadOnly(perspectiveBotId: perspective)
            }
            if room.memberIds.count > 2 {
                return .showParticipantPicker
            }
            return .unavailable
        }
        return .openSharedRoom(perspectiveBotId: perspective)
    }

    private static func perspectiveBotId(
        memberIds: [String],
        invokingBotId: String?,
        counterpartBotId: String
    ) -> String {
        if let invokingBotId, memberIds.contains(invokingBotId) {
            return invokingBotId
        }
        if memberIds.contains(counterpartBotId) {
            return counterpartBotId
        }
        return memberIds.first ?? counterpartBotId
    }
}
