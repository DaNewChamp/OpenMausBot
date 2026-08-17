// The client's state, and the fold that maintains it.
//
// This mirrors the reducer in `src/state/store.tsx`, and is deliberately a
// plain struct with a pure `apply(_:)` rather than anything observable: the
// fold is the part worth testing, and it should be testable without a
// server, a socket, or a UI.
//
// The harness has already turned provider events into settled messages, so
// the work here is small — append, patch, replace. That is the whole reason
// a phone client is a weekend of work rather than a rewrite.
import Foundation

public struct CompanionState: Sendable {
    public var bots: [Bot] = []
    public var rooms: [Room] = []
    /// Transcripts by thread, which is the key both bots and rooms share.
    public var messages: [String: [Message]] = [:]
    /// Whether there is more transcript above what we hold, per thread.
    public var hasMore: [String: Bool] = [:]
    /// The last frame we folded — what a reconnect resumes from.
    public var cursor: String?
    /// Notifications that arrived while connected, newest last.
    public var notifications: [NotificationFrame] = []
    /// The reply being typed, per thread — cleared when it settles into a
    /// `Message`. Not persisted and not hydrated: it is what is happening
    /// right now, and a reconnect that missed it gets the settled message
    /// instead, which is strictly better.
    public var streaming: [String: String] = [:]
    /// The bot's reasoning, per thread, when the provider emits it. Kept
    /// apart from `streaming` because it is not the answer — running them
    /// together reads as the bot contradicting itself mid-sentence.
    public var reasoning: [String: String] = [:]
    /// The latest frame of each bot's computer, base64, while something is
    /// watching. Only ever populated when the stream was opened with
    /// `screens=on`, and only the newest frame is kept — these are hundreds
    /// of kilobytes each and a history of them is worth nothing.
    public var screens: [String: ScreenFrame] = [:]

    public init() {}

    // MARK: - Reading

    /// Named `transcript`, not `messages`: sharing a base name with the
    /// stored property compiles but reads as if one shadows the other.
    public func transcript(forThread threadId: String) -> [Message] {
        messages[threadId] ?? []
    }

    public func bot(_ id: String) -> Bot? {
        bots.first { $0.id == id }
    }

    public func bot(forThread threadId: String) -> Bot? {
        bots.first { $0.threadId == threadId }
    }

    public func room(forThread threadId: String) -> Room? {
        rooms.first { $0.threadId == threadId }
    }

    /// Every unanswered approval or question, newest first. This is the
    /// screen the whole companion exists for.
    public var pendingApprovals: [(threadId: String, message: Message)] {
        var out: [(threadId: String, message: Message)] = []
        for (threadId, thread) in messages {
            for message in thread where message.card?.isPending == true {
                out.append((threadId: threadId, message: message))
            }
        }
        return out.sorted { $0.message.at > $1.message.at }
    }

    /// Chats worth a badge.
    public var unreadCount: Int {
        bots.filter { $0.unread && $0.hidden != true }.count + rooms.filter(\.unread).count
    }

    // MARK: - Hydrating

    /// Replace everything from a `GET /api/bots` response.
    public mutating func hydrate(_ fleet: Fleet) {
        bots = fleet.bots
        rooms = fleet.groups
        messages.removeAll()
        hasMore.removeAll()
        for bot in fleet.bots {
            messages[bot.threadId] = bot.messages ?? []
            hasMore[bot.threadId] = bot.hasMore ?? false
        }
        for room in fleet.groups {
            messages[room.threadId] = room.messages ?? []
            hasMore[room.threadId] = room.hasMore ?? false
        }
    }

    /// Prepend an older page fetched for scrollback.
    public mutating func prepend(_ page: ThreadPage, toThread threadId: String) {
        let existing = messages[threadId] ?? []
        let known = Set(existing.map(\.id))
        messages[threadId] = page.messages.filter { !known.contains($0.id) } + existing
        hasMore[threadId] = page.hasMore ?? false
    }

    // MARK: - Folding

    public mutating func apply(_ streamFrame: StreamFrame) {
        apply(streamFrame.frame)
    }

    public mutating func apply(_ frame: Frame) {
        switch frame {
        case let .hello(cursor, resumed):
            // Where the cursor goes depends on `resumed`, and getting it wrong
            // loses frames silently.
            //
            // On a RESUMED stream the server replays the missed frames AFTER
            // this hello, each delivered through the normal path that calls
            // `advance(to:)`. Jumping the cursor to the server's current
            // position here would claim we had already seen frames still in
            // flight — and if the connection drops mid-replay (an app-switcher
            // peek, a lock), the next reconnect asks `?since=` that position and
            // the skipped frames are gone, with no error and no symptom. So on a
            // resume we keep our position and let the replayed frames advance it.
            //
            // On a full hydrate (not resumed) the client is about to fetch
            // current state, so adopting the server's position is correct — and
            // a first connection has no cursor yet, so we must take one to
            // establish the stream id `advance(to:)` reuses.
            if !resumed || self.cursor == nil {
                self.cursor = cursor
            }

        case let .message(threadId, message):
            append(message, to: threadId)
            // A settled reply supersedes whatever was streaming into it.
            // Without this the live bubble survives alongside the real one:
            // the tail renders below any card or chip that settled next, and
            // the next block's deltas append onto the duplicated tail
            // instead of starting fresh. The desktop client learned this the
            // hard way; no reason to learn it twice.
            if message.role == .bot, message.kind == .text {
                clearStream(threadId)
            }

        case let .messagePatch(threadId, message):
            var thread = messages[threadId] ?? []
            if let index = thread.firstIndex(where: { $0.id == message.id }) {
                thread[index] = message
                messages[threadId] = thread
            } else {
                // a patch for something we never saw — the append is more
                // useful than dropping it, and dedupes on id anyway
                append(message, to: threadId)
            }

        case let .thread(threadId, activeLeafId):
            if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
                bots[index].activeLeafId = activeLeafId
            }
            // A thread frame means the visible branch moved (an edit or a
            // version switch on the desktop). Text half-streamed into the branch
            // that was just abandoned has nowhere to land — drop it, as the
            // desktop does on the same frame.
            clearStream(threadId)

        case let .bot(bot):
            // Frames carry the bot record without its transcript, so merge
            // rather than replace: assigning would wipe the messages the
            // hydrate put there.
            //
            // The exception is a TASK SWITCH. When a bot changes which task is
            // live, the harness broadcasts a full bot record with a NEW
            // `threadId` and that task's own transcript (server/index.ts, "a
            // partial patch would leave the client showing the previous task's
            // conversation"). The desktop honours this (store.tsx switchedThread
            // branch); the phone must too, or the chat goes blank until a cold
            // hydrate. Adopt the incoming transcript for the new thread, and
            // drop any half-streamed text from the task we just left.
            if let index = bots.firstIndex(where: { $0.id == bot.id }) {
                let previousThread = bots[index].threadId
                let switchedThread = bot.threadId != previousThread
                var merged = bot
                if switchedThread, let incoming = bot.messages {
                    messages[bot.threadId] = incoming
                    hasMore[bot.threadId] = false
                    clearStream(previousThread)
                    clearStream(bot.threadId)
                    merged.messages = incoming
                } else {
                    merged.messages = bots[index].messages
                }
                merged.activeLeafId = bot.activeLeafId ?? bots[index].activeLeafId
                bots[index] = merged
            } else {
                bots.append(bot)
                if messages[bot.threadId] == nil {
                    messages[bot.threadId] = bot.messages ?? []
                }
            }

        case let .botDeleted(botId):
            if let index = bots.firstIndex(where: { $0.id == botId }) {
                let threadId = bots[index].threadId
                messages.removeValue(forKey: threadId)
                hasMore.removeValue(forKey: threadId)
                // Everything else keyed by this bot goes too. A deleted bot
                // whose live text survives is a thread that keeps "typing"
                // with nothing to type into, and a retained screen frame is
                // hundreds of kilobytes of a desktop nobody can look at any
                // more — held for as long as the app runs, because deletion
                // was the last event that could ever mention this id.
                clearStream(threadId)
                clearScreen(botId)
                bots.remove(at: index)
            }

        case let .room(room):
            if let index = rooms.firstIndex(where: { $0.id == room.id }) {
                var merged = room
                merged.messages = rooms[index].messages
                rooms[index] = merged
            } else {
                rooms.append(room)
                if messages[room.threadId] == nil {
                    messages[room.threadId] = room.messages ?? []
                }
            }

        case let .roomDeleted(groupId):
            if let index = rooms.firstIndex(where: { $0.id == groupId }) {
                let threadId = rooms[index].threadId
                messages.removeValue(forKey: threadId)
                hasMore.removeValue(forKey: threadId)
                // Same reasoning as a deleted bot: the thread is gone, so the
                // half-written reply streaming into it has nowhere to land.
                clearStream(threadId)
                rooms.remove(at: index)
            }

        case let .notify(notification):
            notifications.append(notification)

        case let .runtime(event):
            apply(runtime: event)

        case let .screen(botId, png, mime):
            screens[botId] = ScreenFrame(png: png, mime: mime)

        // Nothing to fold: config and provisioning state are not part of
        // this client's job yet.
        case .computer, .config, .unknown:
            break
        }
    }

    /// Live text, before the server has settled it into a `Message`.
    ///
    /// The harness folds provider events into settled messages and also
    /// relays the raw deltas, so a client can have the reply as it is typed
    /// and the authoritative record when the turn ends. Rendering only the
    /// settled message — which is what this did until now — means a long
    /// answer looks like nothing is happening for thirty seconds.
    private mutating func apply(runtime event: RuntimeEvent) {
        switch event.type {
        case "content.delta":
            guard let delta = event.delta, !delta.isEmpty else { return }
            switch event.streamKind {
            case "assistant_text":
                streaming[event.threadId, default: ""] += delta
            case "reasoning_text":
                reasoning[event.threadId, default: ""] += delta
            default:
                // an unknown stream kind is not ours to guess at; dropping it
                // is better than showing thinking as if it were the answer
                break
            }
        case "turn.completed", "turn.failed", "turn.aborted":
            clearStream(event.threadId)
        default:
            break
        }
    }

    /// Forget a bot's screen. Called when the panel closes, so the next one
    /// opens on a live frame rather than on however the desktop looked when
    /// it was last watched.
    public mutating func clearScreen(_ botId: String) {
        screens.removeValue(forKey: botId)
    }

    /// Drop a thread's live text. The settled message that triggers this
    /// already contains every token it held.
    public mutating func clearStream(_ threadId: String) {
        streaming.removeValue(forKey: threadId)
        reasoning.removeValue(forKey: threadId)
    }

    /// Append, unless we already hold it. Replaying a resumed stream can
    /// legitimately deliver a message twice — the cursor is the last frame
    /// *received*, and a frame in flight when the socket dropped arrives
    /// again on reconnect.
    private mutating func append(_ message: Message, to threadId: String) {
        var thread = messages[threadId] ?? []
        if let index = thread.firstIndex(where: { $0.id == message.id }) {
            thread[index] = message
        } else {
            thread.append(message)
        }
        messages[threadId] = thread
    }
}

extension CompanionState {
    /// Advance the cursor to a frame's sequence, keeping the stream id.
    ///
    /// The cursor is `<streamId>:<seq>` and opaque to us except for this:
    /// the id half must be carried forward, because it is what stops the
    /// server replaying a previous run's frames into our state.
    public mutating func advance(to seq: Int?) {
        guard let seq, let cursor, let streamId = cursor.split(separator: ":").first else { return }
        self.cursor = "\(streamId):\(seq)"
    }
}
