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
    /// Notifications that arrived while connected, newest last. Kept as a
    /// small recent window until the app has a real notification surface.
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
    /// Pin choices retained on the phone when an older paired server exposes
    /// neither the narrow pin route nor the legacy general PATCH route.
    public var pinnedOverrides = ConversationPinOverrides()
    /// Character choices retained on the phone when an older paired server
    /// rejects appearance fields on the paired-safe profile route.
    public var appearanceOverrides = BotAppearanceOverrides()
    /// Last read assistant revision per conversation, persisted on the phone.
    public var readReceipts = ConversationReadReceipts()
    /// Temporary Hermes/MoA agents nested under a parent chat.
    public var hermesSubagents: [HermesSubagentActivity] = []
    /// Threads whose live tail has been replaced by a settled message or a
    /// terminal turn. Late deltas are ignored until a new turn starts.
    var streamSealed: Set<String> = []
    /// Recent provider event ids per thread, so a replayed reconnect cannot
    /// append the same token twice.
    var seenStreamEventIds: [String: [String]] = [:]
    /// Threads where reconnect replay of the settled tail must be dropped.
    /// Cleared on `turn.started` so a new turn can reuse the same prefix.
    var settledReplayGuard: Set<String> = []
    /// Last accepted delta per thread+kind. Used only while a resumed hello
    /// is catching up — an isolated repeat of the last token is otherwise a
    /// real consecutive increment (`" world"` + `" world"`).
    var lastStreamDelta: [String: String] = [:]
    /// Set by `hello(resumed: true)`. Catch-up replay of the live tail is
    /// otherwise the same bytes as live tokens when event ids are missing.
    var reconnectReplayActive = false
    /// Per thread+kind: catch-up for that stream has been consumed, or a
    /// live token was accepted. Keyed like `lastStreamDelta`.
    var liveCaughtUp: Set<String> = []
    /// Prefix of the held tail already matched during reconnect catch-up.
    var replayedStreamPrefix: [String: String] = [:]

    public init() {}

    // MARK: - Reading

    /// Named `transcript`, not `messages`: sharing a base name with the
    /// stored property compiles but reads as if one shadows the other.
    public func transcript(forThread threadId: String) -> [Message] {
        messages[threadId] ?? []
    }

    /// Live bubble vs working row for this thread, after reconnect and settle.
    public func liveTailPresentation(forThread threadId: String) -> LiveTailKind {
        let last = visibleTranscript(forThread: threadId).last
        let group = room(forThread: threadId)
        let owner = bot(forThread: threadId)
        return LiveTailPolicy.presentation(
            busy: owner?.busy == true || group?.busyBotId != nil,
            streaming: streaming[threadId],
            reasoning: reasoning[threadId],
            lastMessage: last,
            speakerBotId: group?.busyBotId,
            suppressSettledReplay: settledReplayGuard.contains(threadId)
        )
    }

    /// The active branch of a bot conversation. Rooms and legacy linear
    /// threads return their full transcript.
    public func visibleTranscript(forThread threadId: String) -> [Message] {
        let all = transcript(forThread: threadId)
        guard let leafId = bot(forThread: threadId)?.activeLeafId else { return all }
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { _, newest in newest })
        guard var current = byId[leafId] else { return all }
        var visible: [Message] = []
        var visited = Set<String>()
        while visited.insert(current.id).inserted {
            visible.append(current)
            guard let parentId = current.parentId, let parent = byId[parentId] else { break }
            current = parent
        }
        return visible.reversed()
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
        let activeThreads = bots.map(\.threadId) + rooms.map(\.threadId)
        for threadId in activeThreads {
            for message in visibleTranscript(forThread: threadId) where message.card?.isPending == true {
                out.append((threadId: threadId, message: message))
            }
        }
        return out.sorted { $0.message.at > $1.message.at }
    }

    /// Chats worth a badge. Hidden bot⇄bot channels count only when shown.
    public func unreadCount(showBotChannels: Bool = false) -> Int {
        let visibleRooms = BotChannelPolicy.rosterRooms(rooms, showBotChannels: showBotChannels)
        return bots.filter { $0.unread && $0.hidden != true }.count + visibleRooms.filter(\.unread).count
    }

    // MARK: - Hydrating

    /// Replace everything from a `GET /api/bots` response.
    public mutating func hydrate(_ fleet: Fleet) {
        bots = fleet.bots
        rooms = fleet.groups
        for index in bots.indices {
            let stableID = "bot:\(bots[index].id)"
            if bots[index].pinned != nil {
                pinnedOverrides.reconcile(serverPinned: bots[index].pinned, for: stableID)
            } else if let local = pinnedOverrides.value(for: stableID) {
                bots[index].pinned = local
            }
            bots[index] = applyingAppearanceOverride(to: bots[index], stableID: stableID)
        }
        for index in rooms.indices {
            let stableID = "room:\(rooms[index].id)"
            if rooms[index].pinned != nil {
                pinnedOverrides.reconcile(serverPinned: rooms[index].pinned, for: stableID)
            } else if let local = pinnedOverrides.value(for: stableID) {
                rooms[index].pinned = local
            }
        }
        messages.removeAll()
        hasMore.removeAll()
        for bot in fleet.bots {
            if let transcript = bot.messages {
                messages[bot.threadId] = transcript
            }
            if let more = bot.hasMore {
                hasMore[bot.threadId] = more
            }
        }
        for room in fleet.groups {
            if let transcript = room.messages {
                messages[room.threadId] = transcript
            }
            if let more = room.hasMore {
                hasMore[room.threadId] = more
            }
        }
        // Hydration is the authoritative transcript. Any in-flight tail from a
        // previous connection is either already in those messages or gone.
        streaming.removeAll()
        reasoning.removeAll()
        seenStreamEventIds.removeAll()
        settledReplayGuard.removeAll()
        lastStreamDelta.removeAll()
        replayedStreamPrefix.removeAll()
        liveCaughtUp.removeAll()
        reconnectReplayActive = false
        streamSealed.removeAll()
        for bot in bots where bot.busy != true {
            streamSealed.insert(bot.threadId)
        }
        for room in rooms where room.busyBotId == nil {
            streamSealed.insert(room.threadId)
        }
        hermesSubagents = fleet.hermesSubagents
    }

    /// Prepend an older page fetched for scrollback.
    public mutating func prepend(_ page: ThreadPage, toThread threadId: String) {
        let existing = messages[threadId] ?? []
        let known = Set(existing.map(\.id))
        messages[threadId] = page.messages.filter { !known.contains($0.id) } + existing
        if let more = page.hasMore {
            hasMore[threadId] = more
        } else {
            hasMore.removeValue(forKey: threadId)
        }
    }

    /// Merge a search landing window into the pages already held.
    public mutating func merge(_ page: ThreadPage, intoThread threadId: String) {
        var byId = Dictionary(
            uniqueKeysWithValues: (messages[threadId] ?? []).map { ($0.id, $0) }
        )
        for message in page.messages { byId[message.id] = message }
        messages[threadId] = byId.values.sorted {
            $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at
        }
        if let more = page.hasMore { hasMore[threadId] = more }
    }

    /// User-message alternatives created by edit-and-retry, oldest first.
    public func versions(of message: Message, inThread threadId: String) -> [Message] {
        guard message.role == .user, message.kind == .text else { return [] }
        return transcript(forThread: threadId)
            .filter { $0.role == .user && $0.kind == .text && $0.parentId == message.parentId }
            .sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }
    }

    // MARK: - Folding

    public mutating func apply(_ streamFrame: StreamFrame) {
        apply(streamFrame.frame)
    }

    public mutating func apply(_ frame: Frame) {
        switch frame {
        case let .hello(_, resumed):
            // A hello describes the server's latest position, not one this
            // client has folded. Session commits the cursor only after a
            // cold hydration succeeds; resumed streams advance frame by
            // frame. The resumed flag is still folded: without event ids,
            // catch-up tokens are indistinguishable from live increments.
            reconnectReplayActive = resumed
            liveCaughtUp.removeAll()
            replayedStreamPrefix.removeAll()

        case let .message(threadId, message):
            append(message, to: threadId)
            if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
                bots[index].activeLeafId = message.id
            }
            // A settled reply supersedes whatever was streaming into it.
            // Without this the live bubble survives alongside the real one:
            // the tail renders below any card or chip that settled next, and
            // the next block's deltas append onto the duplicated tail
            // instead of starting fresh. The desktop client learned this the
            // hard way; no reason to learn it twice.
            if message.role == .bot, message.kind == .text {
                clearStream(threadId)
                streamSealed.insert(threadId)
                settledReplayGuard.insert(threadId)
            }
            if message.role == .user {
                streamSealed.remove(threadId)
                settledReplayGuard.remove(threadId)
                seenStreamEventIds[threadId] = []
                clearLiveFold(for: threadId)
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
            clearStream(threadId)
            streamSealed.insert(threadId)

        case let .bot(bot):
            let stableID = "bot:\(bot.id)"
            pinnedOverrides.reconcile(serverPinned: bot.pinned, for: stableID)
            // Ordinary frames omit messages and must preserve the transcript.
            // Task switches deliberately include the new task's transcript;
            // that is authoritative and must replace the previous context.
            if let index = bots.firstIndex(where: { $0.id == bot.id }) {
                var merged = bot
                let previous = bots[index]
                if let replacement = bot.messages {
                    messages[bot.threadId] = replacement
                    if let more = bot.hasMore {
                        hasMore[bot.threadId] = more
                    } else {
                        hasMore.removeValue(forKey: bot.threadId)
                    }
                    merged.messages = replacement
                    clearStream(previous.threadId)
                    if previous.threadId != bot.threadId { clearStream(bot.threadId) }
                } else {
                    merged.messages = previous.messages
                    merged.activeLeafId = bot.activeLeafId ?? previous.activeLeafId
                }
                if merged.pinned == nil { merged.pinned = pinnedOverrides.value(for: stableID) }
                bots[index] = applyingAppearanceOverride(to: merged, stableID: stableID)
            } else {
                var merged = bot
                if merged.pinned == nil { merged.pinned = pinnedOverrides.value(for: stableID) }
                bots.append(applyingAppearanceOverride(to: merged, stableID: stableID))
                if let transcript = merged.messages {
                    messages[merged.threadId] = transcript
                }
                if let more = merged.hasMore {
                    hasMore[merged.threadId] = more
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
                streamSealed.remove(threadId)
                settledReplayGuard.remove(threadId)
                seenStreamEventIds.removeValue(forKey: threadId)
                clearLiveFold(for: threadId)
                pinnedOverrides.remove(for: "bot:\(botId)")
                appearanceOverrides.remove(for: "bot:\(botId)")
                bots.remove(at: index)
            }

        case let .room(room):
            let stableID = "room:\(room.id)"
            pinnedOverrides.reconcile(serverPinned: room.pinned, for: stableID)
            if let index = rooms.firstIndex(where: { $0.id == room.id }) {
                var merged = room
                if let replacement = room.messages {
                    messages[room.threadId] = replacement
                    if let more = room.hasMore {
                        hasMore[room.threadId] = more
                    } else {
                        hasMore.removeValue(forKey: room.threadId)
                    }
                } else {
                    merged.messages = rooms[index].messages
                }
                if merged.pinned == nil { merged.pinned = pinnedOverrides.value(for: stableID) }
                rooms[index] = merged
            } else {
                var merged = room
                if merged.pinned == nil { merged.pinned = pinnedOverrides.value(for: stableID) }
                rooms.append(merged)
                if let transcript = merged.messages {
                    messages[merged.threadId] = transcript
                }
                if let more = merged.hasMore {
                    hasMore[merged.threadId] = more
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
                streamSealed.remove(threadId)
                settledReplayGuard.remove(threadId)
                seenStreamEventIds.removeValue(forKey: threadId)
                clearLiveFold(for: threadId)
                pinnedOverrides.remove(for: "room:\(groupId)")
                rooms.remove(at: index)
            }

        case let .notify(notification):
            notifications.append(notification)
            if notifications.count > 100 {
                notifications.removeFirst(notifications.count - 100)
            }

        case let .runtime(event):
            apply(runtime: event)

        case let .hermesSubagent(activity):
            if let index = hermesSubagents.firstIndex(where: { $0.activityId == activity.activityId }) {
                hermesSubagents[index] = activity
            } else {
                hermesSubagents.append(activity)
            }

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
    /// relays the raw deltas. The phone keeps the buffer for reconnect and
    /// duplicate-tail protection; live presentation never paints those
    /// tokens. The authoritative answer is the settled `Message`.
    private mutating func apply(runtime event: RuntimeEvent) {
        switch event.type {
        case "content.delta":
            guard let delta = event.delta, !delta.isEmpty else { return }
            if let eventId = event.eventId, rememberDuplicate(eventId, thread: event.threadId) {
                return
            }
            guard shouldAcceptDelta(delta, on: event.threadId, kind: event.streamKind) else { return }
            switch event.streamKind {
            case "assistant_text":
                recordAcceptedLiveDelta(delta, on: event.threadId, kind: event.streamKind)
                streaming[event.threadId] = StreamDeltaMerge.combining(
                    existing: streaming[event.threadId],
                    delta: delta
                )
            case "reasoning_text":
                recordAcceptedLiveDelta(delta, on: event.threadId, kind: event.streamKind)
                reasoning[event.threadId] = StreamDeltaMerge.combining(
                    existing: reasoning[event.threadId],
                    delta: delta
                )
            default:
                // an unknown stream kind is not ours to guess at; dropping it
                // is better than showing thinking as if it were the answer
                break
            }
        case "turn.started":
            streamSealed.remove(event.threadId)
            settledReplayGuard.remove(event.threadId)
            seenStreamEventIds[event.threadId] = []
            clearStream(event.threadId)
        case "turn.completed", "turn.failed", "turn.aborted":
            clearStream(event.threadId)
            streamSealed.insert(event.threadId)
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
        clearLiveFold(for: threadId)
    }

    private mutating func clearLiveFold(for threadId: String) {
        lastStreamDelta.removeValue(forKey: Self.streamFoldKey(threadId, "assistant_text"))
        lastStreamDelta.removeValue(forKey: Self.streamFoldKey(threadId, "reasoning_text"))
        replayedStreamPrefix.removeValue(forKey: Self.streamFoldKey(threadId, "assistant_text"))
        replayedStreamPrefix.removeValue(forKey: Self.streamFoldKey(threadId, "reasoning_text"))
        liveCaughtUp.remove(Self.streamFoldKey(threadId, "assistant_text"))
        liveCaughtUp.remove(Self.streamFoldKey(threadId, "reasoning_text"))
    }

    private mutating func recordAcceptedLiveDelta(_ delta: String, on threadId: String, kind: String?) {
        let key = Self.streamFoldKey(threadId, kind)
        lastStreamDelta[key] = delta
        replayedStreamPrefix.removeValue(forKey: key)
        liveCaughtUp.insert(key)
    }

    private static func streamFoldKey(_ threadId: String, _ kind: String?) -> String {
        "\(threadId)\u{1e}\(kind ?? "")"
    }

    private mutating func shouldAcceptDelta(_ delta: String, on threadId: String, kind: String?) -> Bool {
        let busy = bot(forThread: threadId)?.busy == true
            || room(forThread: threadId)?.busyBotId != nil
        // Replayed tokens that already live in the settled bubble must not
        // unseal the turn — that is the duplicate-tail reconnect bug.
        if isReplayOfSettledReply(delta, on: threadId) {
            return false
        }
        if isReconnectReplayOfLiveTail(delta, on: threadId, kind: kind) {
            return false
        }
        if streamSealed.contains(threadId) {
            guard busy else { return false }
            streamSealed.remove(threadId)
            return true
        }
        return true
    }

    /// Catch-up without event ids. A resumed hello is the only signal that
    /// an isolated last-token repeat is replay rather than a real consecutive
    /// increment. Prefix restart of the held tail is the same catch-up.
    ///
    /// Full-tail identity (`held == delta`) is a global drop, live or replay:
    /// that is snapshot reconnect (one delta that is the whole tail), not a
    /// consecutive fragment. Consecutive identical *fragments* still append
    /// once this kind's catch-up has been consumed.
    private mutating func isReconnectReplayOfLiveTail(
        _ delta: String,
        on threadId: String,
        kind: String?
    ) -> Bool {
        let key = Self.streamFoldKey(threadId, kind)
        let held: String
        switch kind {
        case "reasoning_text":
            held = reasoning[threadId] ?? ""
        default:
            held = streaming[threadId] ?? ""
        }

        if !held.isEmpty, held == delta {
            if isCatchingUp(key) {
                markStreamCaughtUp(key)
            }
            return true
        }

        if let walked = replayedStreamPrefix[key] {
            let next = walked + delta
            if !held.isEmpty, held.hasPrefix(next) {
                if next == held {
                    replayedStreamPrefix.removeValue(forKey: key)
                    markStreamCaughtUp(key)
                } else {
                    replayedStreamPrefix[key] = next
                }
                return true
            }
            replayedStreamPrefix.removeValue(forKey: key)
        }

        guard isCatchingUp(key) else { return false }

        if !held.isEmpty, held.hasPrefix(delta), held != delta {
            replayedStreamPrefix[key] = delta
            return true
        }
        if lastStreamDelta[key] == delta {
            markStreamCaughtUp(key)
            return true
        }
        return false
    }

    private func isCatchingUp(_ key: String) -> Bool {
        reconnectReplayActive && !liveCaughtUp.contains(key)
    }

    private mutating func markStreamCaughtUp(_ key: String) {
        liveCaughtUp.insert(key)
    }

    /// Reconnect replay of a prefix already committed as a bot text message.
    /// Suffix matches are reconnect-only: a new-turn token emitted before
    /// `turn.started` can suffix the previous settled reply without being
    /// a replay of it.
    private func isReplayOfSettledReply(_ delta: String, on threadId: String) -> Bool {
        guard settledReplayGuard.contains(threadId) else { return false }
        let last = visibleTranscript(forThread: threadId).last
        let speaker = room(forThread: threadId)?.busyBotId
        if LiveTailPolicy.duplicatesSettledReply(
            delta,
            lastMessage: last,
            speakerBotId: speaker
        ) {
            return true
        }
        guard reconnectReplayActive,
              (streaming[threadId] ?? "").isEmpty,
              last?.role == .bot,
              last?.kind == .text,
              let text = last?.text,
              !delta.isEmpty,
              text.hasSuffix(delta)
        else { return false }
        return true
    }

    /// Returns true when this id has already been folded for the thread.
    private mutating func rememberDuplicate(_ eventId: String, thread threadId: String) -> Bool {
        guard !eventId.isEmpty else { return false }
        var seen = seenStreamEventIds[threadId] ?? []
        if seen.contains(eventId) { return true }
        seen.append(eventId)
        if seen.count > 512 {
            seen.removeFirst(seen.count - 512)
        }
        seenStreamEventIds[threadId] = seen
        return false
    }

    /// Apply a pin immediately after an old server rejected both supported
    /// routes. The record mirrors the override so legacy views that inspect
    /// `bot.pinned` or `room.pinned` still move the conversation to the shelf.
    public mutating func setLocalPinned(_ pinned: Bool, for stableID: String) {
        pinnedOverrides.set(pinned, for: stableID)
        if stableID.hasPrefix("bot:"),
           let botID = stableID.split(separator: ":", maxSplits: 1).last,
           let index = bots.firstIndex(where: { $0.id == botID }) {
            bots[index].pinned = pinned
        } else if stableID.hasPrefix("room:"),
                  let roomID = stableID.split(separator: ":", maxSplits: 1).last,
                  let index = rooms.firstIndex(where: { $0.id == roomID }) {
            rooms[index].pinned = pinned
        }
    }

    /// Keep a pending character choice visible while the paired server is
    /// upgraded. The next authoritative bot frame reconciles each field that
    /// the server now echoes and removes it from the override map.
    public mutating func setLocalAppearance(_ override: BotAppearanceOverride, for stableID: String) {
        appearanceOverrides.set(override, for: stableID)
        guard stableID.hasPrefix("bot:"),
              let botID = stableID.split(separator: ":", maxSplits: 1).last,
              let index = bots.firstIndex(where: { $0.id == botID })
        else { return }
        bots[index] = applyingAppearanceOverride(to: bots[index], stableID: stableID)
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

    /// Overlay only fields that are still pending. When an authoritative
    /// response finally includes one, retire that field instead of allowing a
    /// stale local value to shadow the server forever.
    private mutating func applyingAppearanceOverride(to bot: Bot, stableID: String) -> Bot {
        guard var override = appearanceOverrides.value(for: stableID) else { return bot }
        var merged = bot
        if let color = override.color {
            if bot.color == color {
                override.color = nil
            } else {
                merged.color = color
            }
        }
        if let shape = override.mascotShape {
            if bot.mascotShape == shape {
                override.mascotShape = nil
            } else {
                merged.mascotShape = shape
            }
        }
        if let url = override.avatarUrl {
            if bot.avatarUrl == url {
                override.avatarUrl = nil
            } else {
                merged.avatarUrl = url
            }
        }
        if let crop = override.avatarCrop {
            if bot.avatarCrop == crop {
                override.avatarCrop = nil
            } else {
                merged.avatarCrop = crop
            }
        }
        appearanceOverrides.set(override, for: stableID)
        return merged
    }
}

extension CompanionState {
    /// Commit an authoritative cursor after a cold hydration succeeds.
    public mutating func resetCursor(_ cursor: String) {
        self.cursor = cursor
    }

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
