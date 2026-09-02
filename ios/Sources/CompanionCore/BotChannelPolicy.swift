import Foundation

/// Auto-created bot⇄bot channels share one canonical transcript in a `dm`
/// room. They stay out of the main roster unless the user opts in.
public enum BotChannelPolicy {
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
}
