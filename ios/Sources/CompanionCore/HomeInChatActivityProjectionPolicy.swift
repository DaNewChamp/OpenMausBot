import Foundation

/// Scopes home-activity projection to a parent chat. Home-level surfaces pass
/// no parent thread and keep fleet-wide aggregation; in-chat surfaces pass the
/// open thread so unrelated bots and rooms do not appear in the composer pill.
public enum HomeInChatActivityProjectionPolicy: Sendable {
    public static func scopedSubagents(
        _ subagents: [HermesSubagentActivity],
        parentThreadId: String
    ) -> [HermesSubagentActivity] {
        subagents.filter {
            $0.parentThreadId == parentThreadId || $0.transcriptThreadId == parentThreadId
        }
    }

    /// `nil` keeps fleet-wide aggregation; a parent thread limits non-subagent
    /// rows to that conversation.
    public static func scopedThreadId(parentThreadId: String?) -> String? {
        parentThreadId
    }

    /// In-chat surfaces show temporary-agent rows only; fleet busy/finished
    /// rows stay on the home roster.
    public static func includesFleetActivityRows(parentThreadId: String?) -> Bool {
        parentThreadId == nil
    }
}
