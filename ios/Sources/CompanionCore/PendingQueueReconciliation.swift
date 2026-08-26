import Foundation

/// Reconciles local queue acknowledgements with the server transcript.
/// Queue text is deliberately not part of this decision: identical messages
/// are valid, and only the server-assigned queue id identifies one send.
public enum PendingQueueReconciliation {
    /// Returns the queue ids still waiting locally after a transcript update.
    /// An authoritative refresh means the server has replaced the local view;
    /// anything not present in that view is no longer actionable on this
    /// device and can be retired.
    public static func remainingQueueIDs(
        pendingQueueIDs: [String],
        transcript: [Message],
        authoritativeRefresh: Bool = false
    ) -> Set<String> {
        guard !authoritativeRefresh else { return [] }
        let delivered = Set(
            transcript
                .filter { $0.role == .user }
                .compactMap(\.queueId)
        )
        return Set(pendingQueueIDs).subtracting(delivered)
    }
}
