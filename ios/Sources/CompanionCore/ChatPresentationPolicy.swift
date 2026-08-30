import Foundation

/// Chat chrome that is independent of a specific provider or harness.
/// Live tokens may still fold into `CompanionState.streaming` for reconnect
/// and duplicate-tail protection; this policy is what the phone may paint.
public enum ChatPresentationPolicy {
    /// Token-by-token assistant prose is never a live bubble. The settled
    /// `Message` is the only assistant text the transcript shows.
    public static let revealsLiveAssistantProse = false

    /// The four post-response suggestion chips (Show diff, Run tests,
    /// Explain steps, What's next?) are not part of the iOS chat surface.
    /// Mentions, slash commands, stop, and tool/approval cards stay.
    public static func showsPostResponseSuggestionRow(
        draftIsEmpty: Bool = true,
        busy: Bool = false,
        hasPendingApproval: Bool = false
    ) -> Bool {
        _ = draftIsEmpty
        _ = busy
        _ = hasPendingApproval
        return false
    }

    /// Status line while a turn is active. Never a live token prefix.
    public static func workingStatusLine(
        streaming: String? = nil,
        lastMessage: Message?
    ) -> String {
        _ = streaming
        if let last = lastMessage, last.kind == .activity, let tool = last.tool {
            return tool.name
        }
        return "Working…"
    }
}
