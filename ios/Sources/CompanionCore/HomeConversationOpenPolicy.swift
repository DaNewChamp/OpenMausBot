import Foundation

/// Read-on-open behavior for every home entry path. ChatView still owns the
/// idempotent server mark-read retry; home navigation clears local unread
/// immediately so roster dots and badges update before the chat appears.
public enum HomeConversationOpenPolicy: Sendable {
    public static func applyImmediateRead(
        state: inout CompanionState,
        stableID: String,
        threadId: String
    ) {
        state.markConversationRead(stableID: stableID, threadId: threadId)
        state.reconcileUnreadIndicators(visibleThreadId: threadId)
    }
}
