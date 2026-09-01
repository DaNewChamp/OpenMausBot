// What the Updates pill shows: only the chats doing something.
//
// Three kinds, in the order a person cares about them — a bot that has
// stopped and needs an answer, a bot mid-turn, and a bot that finished with
// something you have not read. A bot that is idle and read is not an update
// and never appears here; that is what the roster below is for.
import Foundation
import CompanionCore

struct ChatUpdate: Identifiable, Hashable {
    enum Kind: Int, Comparable {
        case needsYou = 0, working, toReview
        static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }
    }

    let chat: Chat
    let kind: Kind
    /// One line under the name — the question, what it is doing, or what it said.
    let line: String
    /// The card to answer, when `kind == .needsYou`.
    let card: OptionCard?

    var id: String { chat.id }

    init(chat: Chat, kind: Kind, line: String, card: OptionCard?) {
        self.chat = chat
        self.kind = kind
        self.line = line
        self.card = card
    }

    /// Bridges the renderer-neutral home projection to the app's existing
    /// chat update row. Keeping this adapter in the app layer means core
    /// never needs to know SwiftUI's `Chat` enum or navigation stack.
    init?(item: HomeActivityPresentation.Item, chat: Chat) {
        let kind: Kind
        switch item.group {
        case .needsYou: kind = .needsYou
        case .active: kind = .working
        case .queued, .recentlyFinished: kind = .toReview
        }
        self.init(chat: chat, kind: kind, line: item.subtitle, card: item.card)
    }
}

extension CompanionState {
    /// The home rail's single projection. Queue receipts are intentionally
    /// supplied by the caller because this state has no global queue truth.
    func homeActivity(queuedReceipts: [HomeActivityQueueReceipt] = []) -> HomeActivityPresentation {
        homeActivityPresentation(queuedReceipts: queuedReceipts)
    }

    var updates: [ChatUpdate] {
        var out: [ChatUpdate] = []
        var seen = Set<String>()

        // Newest approval first, one per chat: the pill headlines the most
        // recent thing that stopped, and the sheet lists the rest.
        for pending in pendingApprovals {
            guard let chat = chat(forThread: pending.threadId), seen.insert(chat.id).inserted else { continue }
            let card = pending.message.card
            out.append(ChatUpdate(chat: chat, kind: .needsYou, line: card?.subtitle ?? card?.title ?? "", card: card))
        }

        for bot in bots where bot.hidden != true {
            let chat = Chat.bot(bot)
            guard !seen.contains(chat.id) else { continue }
            if bot.busy == true {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .working, line: workingLine(threadId: bot.threadId), card: nil))
            } else if bot.unread {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .toReview, line: lastLine(threadId: bot.threadId), card: nil))
            }
        }
        for room in rooms {
            let chat = Chat.room(room)
            guard !seen.contains(chat.id) else { continue }
            if room.busyBotId != nil {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .working, line: workingLine(threadId: room.threadId), card: nil))
            } else if room.unread {
                seen.insert(chat.id)
                out.append(ChatUpdate(chat: chat, kind: .toReview, line: lastLine(threadId: room.threadId), card: nil))
            }
        }
        return out.sorted { $0.kind < $1.kind }
    }

    func chat(forThread threadId: String) -> Chat? {
        if let bot = bot(forThread: threadId) { return .bot(bot) }
        if let room = room(forThread: threadId) { return .room(room) }
        return nil
    }

    private func workingLine(threadId: String) -> String {
        ChatPresentationPolicy.workingStatusLine(
            streaming: streaming[threadId],
            lastMessage: visibleTranscript(forThread: threadId).last
        )
    }

    private func lastLine(threadId: String) -> String {
        guard let last = visibleTranscript(forThread: threadId).last else { return "" }
        switch last.kind {
        case .text, .unknown: return last.text ?? ""
        case .options: return last.card?.title ?? ""
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        case .connector:
            guard let connector = last.connector, connector.isUsable else { return last.text ?? "" }
            return connector.label
        }
    }
}
