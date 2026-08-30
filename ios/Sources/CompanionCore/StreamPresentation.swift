// Live-reply presentation policy.
//
// The fold in `Store` still concatenates every accepted delta. This file is
// the phone's Grok-like surface on top of that fold: buffer token bursts to a
// short frame cadence, refuse duplicate/late work, and only show markdown
// that will not thrash layout. Views read the reveal helper; Session owns a
// coalescer so `@Published` state does not update once per token.
import Foundation

/// How often buffered deltas may land in the published transcript.
public enum StreamCoalescerAction: Equatable, Sendable {
    case none
    case scheduleFlush(atMs: Int)
    case flushNow([RuntimeEvent])
}

public struct StreamCoalescer: Equatable, Sendable {
    /// ~30 fps. Fast enough to feel live, slow enough that a token storm is
    /// one layout pass instead of one per character.
    public static let flushIntervalMs = 32

    public static func nowMs() -> Int {
        Int(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }

    private struct ThreadBuffer: Equatable {
        var pending: [RuntimeEvent] = []
        var scheduled = false
        var sealed = false
        var seenEventIds: [String] = []
    }

    private var threads: [String: ThreadBuffer] = [:]

    public init() {}

    public mutating func ingest(_ event: RuntimeEvent, nowMs: Int) -> StreamCoalescerAction {
        switch event.type {
        case "content.delta":
            return ingestDelta(event, nowMs: nowMs)
        case "turn.started":
            return flushControl(event, nowMs: nowMs, seal: false, resetSeen: true)
        case "turn.completed", "turn.failed", "turn.aborted":
            return flushControl(event, nowMs: nowMs, seal: true, resetSeen: false)
        default:
            return .none
        }
    }

    public mutating func flush(nowMs: Int) -> [RuntimeEvent] {
        var out: [RuntimeEvent] = []
        for threadId in threads.keys {
            var buffer = threads[threadId] ?? ThreadBuffer()
            guard buffer.scheduled || !buffer.pending.isEmpty else { continue }
            out.append(contentsOf: buffer.pending)
            buffer.pending.removeAll()
            buffer.scheduled = false
            threads[threadId] = buffer
        }
        _ = nowMs
        return out
    }

    public mutating func reset() {
        threads.removeAll()
    }

    public var hasPending: Bool {
        threads.values.contains { $0.scheduled || !$0.pending.isEmpty }
    }

    private mutating func ingestDelta(_ event: RuntimeEvent, nowMs: Int) -> StreamCoalescerAction {
        guard let delta = event.delta, !delta.isEmpty else { return .none }
        switch event.streamKind {
        case "assistant_text", "reasoning_text":
            break
        default:
            return .none
        }

        var buffer = threads[event.threadId] ?? ThreadBuffer()
        if buffer.sealed { return .none }
        if let eventId = event.eventId, !eventId.isEmpty {
            if buffer.seenEventIds.contains(eventId) { return .none }
            buffer.seenEventIds.append(eventId)
            if buffer.seenEventIds.count > 512 {
                buffer.seenEventIds.removeFirst(buffer.seenEventIds.count - 512)
            }
        }

        let wasEmpty = buffer.pending.isEmpty
        buffer.pending.append(event)
        if buffer.scheduled {
            threads[event.threadId] = buffer
            return .none
        }
        if wasEmpty {
            buffer.scheduled = true
            threads[event.threadId] = buffer
            return .scheduleFlush(atMs: nowMs + Self.flushIntervalMs)
        }
        threads[event.threadId] = buffer
        return .none
    }

    private mutating func flushControl(
        _ event: RuntimeEvent,
        nowMs: Int,
        seal: Bool,
        resetSeen: Bool
    ) -> StreamCoalescerAction {
        var buffer = threads[event.threadId] ?? ThreadBuffer()
        var events = buffer.pending
        buffer.pending.removeAll()
        buffer.scheduled = false
        if resetSeen {
            buffer.seenEventIds.removeAll()
            buffer.sealed = false
        }
        if seal { buffer.sealed = true }
        events.append(event)
        threads[event.threadId] = buffer
        _ = nowMs
        return .flushNow(events)
    }
}

/// The prefix of a live reply that is safe to render without malformed
/// markdown or a one-character bubble.
public enum MarkdownReveal {
    /// A run this long is already a chunk, even without a word boundary.
    public static let minimumRevealCount = 24

    public static func visiblePrefix(_ source: String, finalized: Bool = false) -> String? {
        if finalized {
            return source.isEmpty ? nil : source
        }
        let held = holdUnstableSuffix(source)
        guard !held.isEmpty else { return nil }
        if held.contains(where: { $0.isWhitespace || $0 == "\n" }) { return held }
        if held.count >= minimumRevealCount { return held }
        return nil
    }

    private static func holdUnstableSuffix(_ source: String) -> String {
        if source.isEmpty { return "" }
        if hasOpenFence(source) {
            // An opening fence with no body still reads as three backticks.
            // Wait until at least one body character exists.
            if fenceHasBody(source) { return source }
            return withoutOpenFence(source)
        }

        if let incomplete = incompleteInlineRange(in: source) {
            return String(source[..<incomplete])
        }
        return source
    }

    private static func hasOpenFence(_ source: String) -> Bool {
        var open = false
        for line in source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                open.toggle()
            }
        }
        return open
    }

    private static func fenceHasBody(_ source: String) -> Bool {
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard let opener = normalised.range(of: "```") ?? normalised.range(of: "~~~") else {
            return false
        }
        let after = normalised[opener.upperBound...]
        guard let newline = after.firstIndex(of: "\n") else { return false }
        return newline < after.index(before: after.endIndex)
    }

    private static func withoutOpenFence(_ source: String) -> String {
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard let opener = normalised.range(of: "```", options: .backwards)
                ?? normalised.range(of: "~~~", options: .backwards)
        else { return source }
        return String(normalised[..<opener.lowerBound])
    }

    /// Trailing unfinished emphasis or a half-typed link. Those are the
    /// states that reflow when the closer arrives a token later.
    private static func incompleteInlineRange(in source: String) -> String.Index? {
        if let opener = unmatchedDelimitedOpener(in: source, delimiter: "**")
            ?? unmatchedDelimitedOpener(in: source, delimiter: "__") {
            if let space = source[..<opener].lastIndex(where: { $0.isWhitespace || $0 == "\n" }) {
                return source.index(after: space)
            }
            return source.startIndex
        }
        if source.contains("[") {
            let opens = source.filter { $0 == "[" }.count
            let closes = source.filter { $0 == "]" }.count
            if opens > closes {
                if let open = source.lastIndex(of: "[") {
                    if let space = source[..<open].lastIndex(where: { $0.isWhitespace || $0 == "\n" }) {
                        return source.index(after: space)
                    }
                    return source.startIndex
                }
            }
        }
        if source.contains("]("), !source.hasSuffix(")"), !source.contains(") ") {
            let afterLink = source.components(separatedBy: "](").last ?? ""
            if !afterLink.contains(")") {
                if let start = source.lastIndex(of: "[") {
                    if let space = source[..<start].lastIndex(where: { $0.isWhitespace || $0 == "\n" }) {
                        return source.index(after: space)
                    }
                    return source.startIndex
                }
            }
        }
        return nil
    }

    private static func unmatchedDelimitedOpener(in source: String, delimiter: String) -> String.Index? {
        var count = 0
        var index = source.startIndex
        var lastOpener: String.Index?
        while let range = source.range(of: delimiter, range: index..<source.endIndex) {
            count += 1
            if count % 2 == 1 { lastOpener = range.lowerBound }
            index = range.upperBound
        }
        return count % 2 == 1 ? lastOpener : nil
    }
}

/// Fold a live or replayed token into the held tail without duplicating it.
/// Incremental tokens append; a reconnect that redelivers a prefix is
/// ignored; a longer snapshot that starts with the held tail replaces it.
public enum StreamDeltaMerge {
    public static func combining(existing: String?, delta: String) -> String {
        guard let existing, !existing.isEmpty else { return delta }
        if existing == delta || existing.hasPrefix(delta) { return existing }
        if delta.hasPrefix(existing) { return delta }
        return existing + delta
    }
}

public enum LiveTailKind: Equatable, Sendable {
    case none
    case working
    case streaming(String)
}

/// Live bubble vs working row. A settled bot reply at the tail is the
/// transcript; busy remaining true until the bot patch must not resurrect
/// a second bubble or a stuck Working row.
public enum LiveTailPolicy {
    public static func presentation(
        busy: Bool,
        streaming: String?,
        reasoning: String?,
        lastMessage: Message?,
        speakerBotId: String?,
        suppressSettledReplay: Bool = true
    ) -> LiveTailKind {
        let held = streaming ?? ""
        let duplicateOfSettled = suppressSettledReplay && duplicatesSettledReply(
            held,
            lastMessage: lastMessage,
            speakerBotId: speakerBotId
        )
        let effectiveStreaming = duplicateOfSettled ? nil : streaming
        if let visible = MarkdownReveal.visiblePrefix(effectiveStreaming ?? ""), !visible.isEmpty {
            return .streaming(visible)
        }
        if !(reasoning ?? "").isEmpty {
            return .working
        }
        if showsWorking(
            busy: busy,
            streaming: effectiveStreaming,
            lastMessage: lastMessage,
            speakerBotId: speakerBotId
        ) {
            return .working
        }
        return .none
    }

    /// True when replayed live text is already the settled assistant bubble.
    public static func duplicatesSettledReply(
        _ streaming: String,
        lastMessage: Message?,
        speakerBotId: String?
    ) -> Bool {
        guard !streaming.isEmpty, isSettledReply(lastMessage, covering: speakerBotId),
              let text = lastMessage?.text, !text.isEmpty
        else { return false }
        return text == streaming || text.hasPrefix(streaming)
    }

    /// Mirrors the desktop turn-tail rule: a settled bot text at the tail
    /// means there is nothing to wait for until a new speaker or tool chip.
    public static func showsWorking(
        busy: Bool,
        streaming: String?,
        lastMessage: Message?,
        speakerBotId: String?
    ) -> Bool {
        if !busy || !(streaming ?? "").isEmpty { return false }
        guard let lastMessage else { return true }
        if !isSettledReply(lastMessage, covering: nil) { return true }
        return speakerBotId != nil && lastMessage.from?.botId != speakerBotId
    }

    private static func isSettledReply(_ message: Message?, covering speakerBotId: String?) -> Bool {
        guard let message, message.role == .bot, message.kind == .text else { return false }
        guard let speakerBotId, let from = message.from else { return true }
        return from.botId == speakerBotId
    }
}

public enum StreamAccessibilityPhase: Equatable, Sendable {
    case idle
    case working
    case streaming
    case complete
}

/// VoiceOver must not speak the growing reply. Announce phase changes only.
public enum StreamAccessibility {
    public static func phase(isBusy: Bool, hasVisibleText: Bool) -> StreamAccessibilityPhase {
        if hasVisibleText && !isBusy { return .complete }
        if hasVisibleText { return .streaming }
        if isBusy { return .working }
        return .idle
    }

    public static func announcement(
        from old: StreamAccessibilityPhase,
        to new: StreamAccessibilityPhase,
        speaker: String
    ) -> String? {
        if old == new { return nil }
        switch (old, new) {
        case (_, .working):
            return "\(speaker) is working"
        case (.streaming, .idle), (_, .complete):
            return "\(speaker) finished their reply"
        default:
            return nil
        }
    }
}
