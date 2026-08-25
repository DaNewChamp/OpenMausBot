// Consecutive tool activities, folded for the transcript.
//
// The harness already turned provider events into activity messages. This
// does not re-derive those events. It only groups neighbouring chips so the
// phone can show one ChatGPT-style disclosure instead of a stack of receipts.
// Search still lands on a message id: every id in a run stays on the run.
import Foundation

/// One stretch of the transcript: a normal message, or neighbouring tool
/// chips that render as a single disclosure.
public enum TranscriptSegment: Equatable, Hashable, Sendable, Identifiable {
    case message(Message)
    case toolRun(ToolRun)

    public var id: String {
        switch self {
        case .message(let message): return message.id
        case .toolRun(let run): return run.id
        }
    }

    public var messageIds: [String] {
        switch self {
        case .message(let message): return [message.id]
        case .toolRun(let run): return run.messageIds
        }
    }
}

/// Neighbouring foldable tool chips, oldest first. Identity is the first
/// message id so the row stays the same view as later chips append.
public struct ToolRun: Equatable, Hashable, Sendable, Identifiable {
    public var messages: [Message]

    public init(messages: [Message]) {
        self.messages = messages
    }

    public var id: String { messages.first?.id ?? "" }

    public var messageIds: [String] { messages.map(\.id) }

    public var steps: [ToolActivity] { messages.compactMap(\.tool) }

    public var isSettled: Bool {
        !steps.isEmpty && steps.allSatisfy { $0.ok != nil }
    }

    public var hasFailure: Bool {
        steps.contains { $0.ok == false }
    }

    public var failureCount: Int {
        steps.filter { $0.ok == false }.count
    }

    /// Collapsed header. Unsettled work is the latest friendly label, a
    /// single success is that same compact label, and several successes
    /// become "Worked · N steps" with no invented duration.
    public var headerTitle: String {
        if hasFailure {
            if steps.count == 1 {
                return "Failed · \(steps.last.map(ToolRunGrouping.displayLabel(for:)) ?? ToolRunGrouping.genericLabel)"
            }
            return "\(steps.count) steps · \(failureCount) failed"
        }
        if isSettled && steps.count > 1 {
            return "Worked · \(steps.count) steps"
        }
        return steps.last.map(ToolRunGrouping.displayLabel(for:)) ?? ToolRunGrouping.genericLabel
    }
}

public enum ToolRunGrouping {
    public static let genericLabel = "Used a tool"

    /// Fold neighbouring tool chips. Cards, screens, ordinary text,
    /// bot-to-bot comm chips, and turn-level `error:` chips stay as
    /// themselves and split a run.
    public static func segments(in messages: [Message]) -> [TranscriptSegment] {
        var segments: [TranscriptSegment] = []
        var index = messages.startIndex
        while index < messages.endIndex {
            if messages[index].isFoldableToolActivity {
                let start = index
                repeat {
                    index += 1
                } while index < messages.endIndex && canJoin(messages[index], after: messages[index - 1])
                segments.append(.toolRun(ToolRun(messages: Array(messages[start..<index]))))
            } else {
                segments.append(.message(messages[index]))
                index += 1
            }
        }
        return segments
    }

    private static func canJoin(_ message: Message, after previous: Message) -> Bool {
        guard message.isFoldableToolActivity else { return false }
        guard message.role == previous.role else { return false }
        guard message.from?.botId == previous.from?.botId else { return false }
        return message.at - previous.at <= 30 * 60 * 1_000
    }

    /// `spoken` when it is a short phrase a person can read. Anything that
    /// looks like a command, a URL, or empty becomes the generic fallback —
    /// raw tool names belong behind the second disclosure, not here.
    public static func displayLabel(for tool: ToolActivity) -> String {
        safeSpoken(tool.spoken) ?? genericLabel
    }

    public static func isExpandedByDefault(_ run: ToolRun) -> Bool {
        run.hasFailure
    }

    /// Manual open wins, then manual close, then the default. Keeping both
    /// sets lets a later chip landing on the same run id not reset a tap.
    public static func isExpanded(_ run: ToolRun, opened: Set<String>, closed: Set<String>) -> Bool {
        if opened.contains(run.id) { return true }
        if closed.contains(run.id) { return false }
        return isExpandedByDefault(run)
    }

    static func safeSpoken(_ spoken: String?) -> String? {
        guard let spoken else { return nil }
        let trimmed = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.count <= 80 else { return nil }
        guard trimmed.rangeOfCharacter(from: .newlines) == nil else { return nil }
        if trimmed.contains(where: { #""'`$|;"#.contains($0) }) { return nil }
        if trimmed.contains("--") || trimmed.contains("://") { return nil }
        return trimmed
    }
}

extension Message {
    /// A chip the disclosure can absorb. Comm chips are navigation, a
    /// turn-level `error:` is an error row, and an activity with no tool
    /// is nothing to fold.
    var isFoldableToolActivity: Bool {
        guard kind == .activity, let tool, comm == nil else { return false }
        return !tool.name.lowercased().hasPrefix("error:")
    }
}
