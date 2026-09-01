import Foundation

/// The queue acknowledgements this phone has observed while the app is alive.
/// This is intentionally not part of `CompanionState`: the Hub exposes no
/// global queue snapshot, so a missing receipt means "unknown", not "empty".
public struct HomeActivityQueueReceiptStore: Equatable, Sendable {
    private var byQueueID: [String: HomeActivityQueueReceipt] = [:]

    public init() {}

    /// The receipts currently pending on this phone, ordered newest first.
    public var receipts: [HomeActivityQueueReceipt] {
        byQueueID.values.sorted {
            $0.enqueuedAt == $1.enqueuedAt
                ? $0.queueId < $1.queueId
                : $0.enqueuedAt > $1.enqueuedAt
        }
    }

    /// Record only a successful queued acknowledgement. A failed or
    /// non-queued outcome supplies no local queue fact and is ignored.
    @discardableResult
    public mutating func observe(
        _ receipt: MessageDeliveryReceipt,
        enqueuedAt: Double = 0
    ) -> Bool {
        guard receipt.ok,
              let queued = HomeActivityQueueReceipt(receipt: receipt, enqueuedAt: enqueuedAt)
        else { return false }
        byQueueID[queued.queueId] = queued
        return true
    }

    /// Record a successful queue acknowledgement, using the request target as
    /// a safe fallback for older hubs that omit `threadId` in the receipt.
    /// The queue id still has to come from the server; no queue is inferred.
    @discardableResult
    public mutating func observe(
        _ receipt: MessageDeliveryReceipt,
        forThread threadId: String,
        enqueuedAt: Double = 0
    ) -> Bool {
        guard receipt.ok,
              receipt.disposition == .queued,
              let queueId = receipt.queueId
        else { return false }
        let queued = HomeActivityQueueReceipt(
            queueId: queueId,
            threadId: receipt.threadId ?? threadId,
            enqueuedAt: enqueuedAt
        )
        byQueueID[queueId] = queued
        return true
    }

    /// Retire receipts for one thread after a transcript update. A matching
    /// server queue id means the queued send has become a real message. An
    /// authoritative refresh retires anything not represented in that view.
    public mutating func reconcile(
        threadId: String,
        transcript: [Message],
        authoritativeRefresh: Bool = false
    ) {
        let pending = byQueueID.values
            .filter { $0.threadId == threadId }
            .map(\.queueId)
        let remaining = PendingQueueReconciliation.remainingQueueIDs(
            pendingQueueIDs: pending,
            transcript: transcript,
            authoritativeRefresh: authoritativeRefresh
        )
        byQueueID = byQueueID.filter { key, receipt in
            receipt.threadId != threadId || remaining.contains(key)
        }
    }

    /// Reconcile every locally observed receipt against the current state.
    /// Normal stream updates only retire receipts with an explicit queue id;
    /// a complete hydrate may also retire receipts absent from that
    /// authoritative transcript. Missing transcript or pagination metadata is
    /// treated as unknown, not as evidence that the Hub has no queue for the
    /// thread.
    public mutating func reconcile(
        state: CompanionState,
        authoritativeRefresh: Bool = false
    ) {
        let threadIDs = Set(byQueueID.values.map(\.threadId))
        for threadId in threadIDs {
            guard state.messages[threadId] != nil else {
                continue
            }
            let completeTranscript = authoritativeRefresh && state.hasMore[threadId] == false
            reconcile(
                threadId: threadId,
                transcript: state.visibleTranscript(forThread: threadId),
                authoritativeRefresh: completeTranscript
            )
        }
    }
}
