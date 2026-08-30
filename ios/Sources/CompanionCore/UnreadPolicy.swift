import Foundation

/// Device-local read receipts keyed by `bot:<id>` / `room:<id>`. The paired
/// server's `unread` flag stays authoritative on hydrate; receipts let the
/// phone converge notifications, roster dots, and badge counts when a
/// `notify` frame lands without a matching bot patch or a hydrate replays
/// stale fleet data over a live SSE mark.
public struct ConversationReadReceipts: Codable, Equatable, Sendable {
    public static let maxEntries = 256

    private var values: [String: String]

    public init(values: [String: String] = [:]) {
        self.values = values
        trim()
    }

    public func lastReadMessageId(for stableID: String) -> String? {
        values[stableID]
    }

    public mutating func markRead(stableID: String, messageId: String) {
        values[stableID] = messageId
        trim(preserving: stableID)
    }

    public mutating func remove(stableID: String) {
        values.removeValue(forKey: stableID)
    }

    private mutating func trim(preserving stableID: String? = nil) {
        guard values.count > Self.maxEntries else { return }
        for candidate in values.keys.sorted() where values.count > Self.maxEntries {
            if candidate != stableID { values.removeValue(forKey: candidate) }
        }
    }
}

public enum UnreadPolicy: Sendable {
    /// Final assistant content that should advance the unread revision.
    public static func unreadRevision(for message: Message) -> String? {
        guard message.role == .bot else { return nil }
        switch message.kind {
        case .text, .options, .connector, .screen, .unknown:
            return message.id
        case .activity:
            return nil
        }
    }

    public static func latestUnreadRevision(in messages: [Message]) -> String? {
        messages.reversed().compactMap { unreadRevision(for: $0) }.first
    }

    public static func notificationMarksUnread(_ kind: String) -> Bool {
        kind == "done" || kind == "approval" || kind == "question" || kind == "routine-failed"
    }

    public static func shouldMarkUnread(
        revision: String,
        threadId: String,
        visibleThreadId: String?,
        lastReadMessageId: String?,
        messageAlreadyPresent: Bool
    ) -> Bool {
        if visibleThreadId == threadId { return false }
        if lastReadMessageId == revision { return false }
        if messageAlreadyPresent, lastReadMessageId == revision { return false }
        return true
    }

    public static func displaysUnread(
        serverUnread: Bool,
        threadId: String,
        visibleThreadId: String?,
        latestRevision: String?,
        lastReadMessageId: String?
    ) -> Bool {
        if visibleThreadId == threadId { return false }
        if let latestRevision {
            if let lastReadMessageId {
                return lastReadMessageId != latestRevision
            }
            return serverUnread
        }
        return serverUnread
    }

    /// After a full hydrate, align local receipts with the server's unread
    /// flag without inventing unread the server has already cleared.
    public static func readReceiptAfterHydrate(
        serverUnread: Bool,
        latestRevision: String?,
        currentReceipt: String?
    ) -> String? {
        if serverUnread {
            return currentReceipt
        }
        return latestRevision ?? currentReceipt
    }
}

public extension CompanionState {
    func stableID(forThread threadId: String) -> String? {
        if let bot = bot(forThread: threadId) { return "bot:\(bot.id)" }
        if let room = room(forThread: threadId) { return "room:\(room.id)" }
        return nil
    }

    mutating func reconcileUnreadIndicators(visibleThreadId: String?) {
        for index in bots.indices {
            let bot = bots[index]
            let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: bot.threadId))
            let receipt = readReceipts.lastReadMessageId(for: "bot:\(bot.id)")
            bots[index].unread = UnreadPolicy.displaysUnread(
                serverUnread: bot.unread,
                threadId: bot.threadId,
                visibleThreadId: visibleThreadId,
                latestRevision: latest,
                lastReadMessageId: receipt
            )
        }
        for index in rooms.indices {
            let room = rooms[index]
            let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: room.threadId))
            let receipt = readReceipts.lastReadMessageId(for: "room:\(room.id)")
            rooms[index].unread = UnreadPolicy.displaysUnread(
                serverUnread: room.unread,
                threadId: room.threadId,
                visibleThreadId: visibleThreadId,
                latestRevision: latest,
                lastReadMessageId: receipt
            )
        }
    }

    mutating func reconcileReadReceiptsAfterHydrate() {
        for bot in bots {
            let stableID = "bot:\(bot.id)"
            let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: bot.threadId))
            if let receipt = UnreadPolicy.readReceiptAfterHydrate(
                serverUnread: bot.unread,
                latestRevision: latest,
                currentReceipt: readReceipts.lastReadMessageId(for: stableID)
            ) {
                readReceipts.markRead(stableID: stableID, messageId: receipt)
            }
        }
        for room in rooms {
            let stableID = "room:\(room.id)"
            let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: room.threadId))
            if let receipt = UnreadPolicy.readReceiptAfterHydrate(
                serverUnread: room.unread,
                latestRevision: latest,
                currentReceipt: readReceipts.lastReadMessageId(for: stableID)
            ) {
                readReceipts.markRead(stableID: stableID, messageId: receipt)
            }
        }
    }

    mutating func applyUnreadOnFinalMessage(
        threadId: String,
        message: Message,
        visibleThreadId: String?,
        messageAlreadyPresent: Bool
    ) {
        guard let revision = UnreadPolicy.unreadRevision(for: message),
              let stableID = stableID(forThread: threadId)
        else { return }

        let receipt = readReceipts.lastReadMessageId(for: stableID)
        if visibleThreadId == threadId {
            readReceipts.markRead(stableID: stableID, messageId: revision)
            setUnread(false, forThread: threadId)
            return
        }
        guard UnreadPolicy.shouldMarkUnread(
            revision: revision,
            threadId: threadId,
            visibleThreadId: visibleThreadId,
            lastReadMessageId: receipt,
            messageAlreadyPresent: messageAlreadyPresent
        ) else { return }

        setUnread(true, forThread: threadId)
    }

    mutating func applyUnreadOnNotification(
        _ notification: NotificationFrame,
        visibleThreadId: String?
    ) {
        guard UnreadPolicy.notificationMarksUnread(notification.kind) else { return }
        guard visibleThreadId != notification.threadId else { return }
        guard stableID(forThread: notification.threadId) != nil else { return }

        let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: notification.threadId))
        let stableID = stableID(forThread: notification.threadId)!
        let receipt = readReceipts.lastReadMessageId(for: stableID)
        if let latest,
           !UnreadPolicy.displaysUnread(
               serverUnread: true,
               threadId: notification.threadId,
               visibleThreadId: visibleThreadId,
               latestRevision: latest,
               lastReadMessageId: receipt
           ) {
            return
        }
        setUnread(true, forThread: notification.threadId)
    }

    mutating func markConversationRead(stableID: String, threadId: String) {
        if let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: threadId)) {
            readReceipts.markRead(stableID: stableID, messageId: latest)
        }
        setUnread(false, forThread: threadId)
    }

    mutating func applyServerUnreadClear(forThread threadId: String) {
        guard let stableID = stableID(forThread: threadId),
              let latest = UnreadPolicy.latestUnreadRevision(in: transcript(forThread: threadId))
        else { return }
        readReceipts.markRead(stableID: stableID, messageId: latest)
    }

    private mutating func setUnread(_ unread: Bool, forThread threadId: String) {
        if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
            bots[index].unread = unread
        } else if let index = rooms.firstIndex(where: { $0.threadId == threadId }) {
            rooms[index].unread = unread
        }
    }
}
