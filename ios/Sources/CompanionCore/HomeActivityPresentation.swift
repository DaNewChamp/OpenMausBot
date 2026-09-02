import Foundation

/// A queue acknowledgement that the phone has received locally. Queue state
/// is intentionally not part of `CompanionState`: the hub does not advertise
/// a global queue snapshot, so a home surface may only show receipts that this
/// phone has actually observed. Callers should retire a receipt when its
/// `queueId` appears in the settled transcript.
public struct HomeActivityQueueReceipt: Hashable, Sendable {
    public let queueId: String
    public let threadId: String
    public let enqueuedAt: Double

    public init(queueId: String, threadId: String, enqueuedAt: Double = 0) {
        self.queueId = queueId
        self.threadId = threadId
        self.enqueuedAt = enqueuedAt
    }

    public init?(receipt: MessageDeliveryReceipt, enqueuedAt: Double = 0) {
        guard receipt.ok,
              receipt.disposition == .queued,
              let queueId = receipt.queueId,
              let threadId = receipt.threadId
        else { return nil }
        self.init(queueId: queueId, threadId: threadId, enqueuedAt: enqueuedAt)
    }
}

/// Provider-neutral home activity. The app maps `threadId` to its existing
/// `Chat` value for navigation; no provider or engine name belongs in this
/// projection.
public struct HomeActivityPresentation: Equatable, Sendable {
    public enum State: String, Equatable, Sendable {
        case quiet
        case active
        case needsAttention
    }

    public enum Group: String, CaseIterable, Equatable, Sendable {
        case needsYou
        case active
        case queued
        case recentlyFinished

        public var title: String {
            switch self {
            case .needsYou: return "Needs you"
            case .active: return "Active"
            case .queued: return "Queued"
            case .recentlyFinished: return "Recently finished"
            }
        }
    }

    public struct Item: Identifiable, Hashable, Sendable {
        public let id: String
        public let threadId: String
        public let group: Group
        public let title: String
        public let subtitle: String
        public let timestamp: Double
        public let card: OptionCard?
        public let queueCount: Int

        public var kind: Group { group }

        fileprivate init(
            threadId: String,
            group: Group,
            title: String,
            subtitle: String,
            timestamp: Double = 0,
            card: OptionCard? = nil,
            queueCount: Int = 0
        ) {
            self.id = "\(group.rawValue):\(threadId)"
            self.threadId = threadId
            self.group = group
            self.title = title
            self.subtitle = subtitle
            self.timestamp = timestamp
            self.card = card
            self.queueCount = queueCount
        }
    }

    public struct Section: Identifiable, Equatable, Sendable {
        public let kind: Group
        public let items: [Item]

        public var id: Group { kind }
        public var title: String { kind.title }

        fileprivate init(kind: Group, items: [Item]) {
            self.kind = kind
            self.items = items
        }
    }

    public let state: State
    public let sections: [Section]
    public let items: [Item]
    public let temporaryAgentCount: Int

    public init(
        state: CompanionState,
        queuedReceipts: [HomeActivityQueueReceipt] = [],
        subagents: [HermesSubagentActivity] = [],
        parentThreadId: String? = nil
    ) {
        self.init(
            projecting: state,
            queuedReceipts: queuedReceipts,
            subagents: subagents,
            parentThreadId: parentThreadId
        )
    }

    public init(
        state: CompanionState,
        queuedReceipts: [MessageDeliveryReceipt]
    ) {
        self.init(
            projecting: state,
            queuedReceipts: queuedReceipts.compactMap { HomeActivityQueueReceipt(receipt: $0) },
            subagents: []
        )
    }

    /// The one projection entry point used by home views. The explicit queue
    /// argument is a trust boundary: absent receipts mean "unknown", never
    /// "there are no queued messages on the computer".
    public static func summary(
        for state: CompanionState,
        queuedReceipts: [HomeActivityQueueReceipt] = []
    ) -> HomeActivityPresentation {
        HomeActivityPresentation(state: state, queuedReceipts: queuedReceipts)
    }

    public var needsYou: [Item] { items(in: .needsYou) }
    public var active: [Item] { items(in: .active) }
    public var queued: [Item] { items(in: .queued) }
    public var recentlyFinished: [Item] { items(in: .recentlyFinished) }

    /// Number of rows represented by this projection. A queued row represents
    /// several messages when `queueCount` is greater than one; callers that
    /// need a message count should use `totalActivityCount`.
    public var count: Int { items.count }

    public var totalActivityCount: Int {
        items.reduce(into: 0) { result, item in
            result += item.group == .queued ? max(item.queueCount, 1) : 1
        }
    }

    public var collapsedTitle: String {
        switch state {
        case .quiet:
            return "All quiet"
        case .needsAttention:
            return "\(needsYou.count) needs you"
        case .active:
            if temporaryAgentCount > 0, needsYou.isEmpty, queued.isEmpty {
                let remaining = totalActivityCount - temporaryAgentCount
                if remaining == 0 {
                    return temporaryAgentCount == 1 ? "1 agent" : "\(temporaryAgentCount) agents"
                }
            }
            return "\(totalActivityCount) active"
        }
    }

    public var collapsedSubtitle: String {
        switch state {
        case .quiet:
            return "Nothing needs you"
        case .needsAttention:
            return needsYou.count == 1 ? "Review request" : "Review requests"
        case .active:
            return active.isEmpty ? "Open updates" : "Working now"
        }
    }

    public var accessibilityLabel: String {
        switch state {
        case .quiet:
            return "All quiet. Nothing needs you."
        case .needsAttention:
            return "Needs attention. \(totalActivityCount) activity items, \(needsYou.count) need you."
        case .active:
            return "Active. \(totalActivityCount) activity items."
        }
    }

    private func items(in group: Group) -> [Item] {
        sections.first(where: { $0.kind == group })?.items ?? []
    }

    private init(
        projecting state: CompanionState,
        queuedReceipts: [HomeActivityQueueReceipt],
        subagents: [HermesSubagentActivity],
        parentThreadId: String? = nil
    ) {
        let hiddenBotIDs = Set(state.bots.filter { $0.hidden == true }.map(\.threadId))
        let scopedThreadId = HomeInChatActivityProjectionPolicy.scopedThreadId(
            parentThreadId: parentThreadId
        )
        let chats: [(threadId: String, title: String, active: Bool, unread: Bool)] =
            state.bots
                .filter { $0.hidden != true }
                .filter { scopedThreadId == nil || $0.threadId == scopedThreadId }
                .map { ($0.threadId, $0.name, $0.isWorking, $0.unread) }
            + state.rooms
                .filter { scopedThreadId == nil || $0.threadId == scopedThreadId }
                .map { ($0.threadId, $0.name, $0.busyBotId != nil, $0.unread) }
        let knownThreads = Set(chats.map(\.threadId))
        let chatByThread = Dictionary(uniqueKeysWithValues: chats.map { ($0.threadId, $0) })

        var needs: [Item] = []
        var approvalThreads = Set<String>()
        for pending in state.pendingApprovals {
            guard let chat = chatByThread[pending.threadId],
                  approvalThreads.insert(pending.threadId).inserted
            else { continue }
            let card = pending.message.card
            let line = card?.subtitle.isEmpty == false
                ? card?.subtitle ?? ""
                : card?.title ?? ""
            needs.append(Item(
                threadId: pending.threadId,
                group: .needsYou,
                title: chat.title,
                subtitle: line,
                timestamp: pending.message.at,
                card: card
            ))
        }

        let busyThreads = Set(chats.filter(\.active).map(\.threadId))
        let active = chats
            .filter { $0.active && !approvalThreads.contains($0.threadId) }
            .map {
                Item(
                    threadId: $0.threadId,
                    group: .active,
                    title: $0.title,
                    subtitle: "Working now"
                )
            }

        // A queue receipt is local knowledge, not a server-wide queue count.
        // Ignore stale/unknown/hidden threads and collapse several receipts
        // for one chat into one honest row.
        var queueByThread: [String: [HomeActivityQueueReceipt]] = [:]
        for receipt in queuedReceipts where knownThreads.contains(receipt.threadId) {
            guard !hiddenBotIDs.contains(receipt.threadId),
                  !approvalThreads.contains(receipt.threadId)
            else { continue }
            queueByThread[receipt.threadId, default: []].append(receipt)
        }
        let queued = queueByThread.compactMap { threadId, receipts -> Item? in
            guard let chat = chatByThread[threadId] else { return nil }
            let ordered = receipts.sorted {
                $0.enqueuedAt == $1.enqueuedAt ? $0.queueId < $1.queueId : $0.enqueuedAt > $1.enqueuedAt
            }
            return Item(
                threadId: threadId,
                group: .queued,
                title: chat.title,
                subtitle: ordered.count == 1 ? "Queued" : "\(ordered.count) queued",
                timestamp: ordered.first?.enqueuedAt ?? 0,
                queueCount: ordered.count
            )
        }.sorted(by: Self.itemOrder)

        let recentlyFinished = chats
            .filter {
                $0.unread
                    && !$0.active
                    && !approvalThreads.contains($0.threadId)
                    && !busyThreads.contains($0.threadId)
            }
            .map { chat in
                let last = state.visibleTranscript(forThread: chat.threadId).last
                return Item(
                    threadId: chat.threadId,
                    group: .recentlyFinished,
                    title: chat.title,
                    subtitle: Self.messageLine(last),
                    timestamp: last?.at ?? 0
                )
            }
            .sorted(by: Self.itemOrder)

        let liveSubagents = subagents.filter { $0.status == .started || $0.status == .updated }
        let completedSubagents = subagents.filter { $0.status == .completed }
        self.temporaryAgentCount = liveSubagents.count
        let subagentActive = liveSubagents.map { activity in
            Item(
                threadId: activity.transcriptThreadId,
                group: .active,
                title: activity.title,
                subtitle: "Working now"
            )
        }
        let subagentFinished = completedSubagents.map { activity in
            Item(
                threadId: activity.transcriptThreadId,
                group: .recentlyFinished,
                title: activity.title,
                subtitle: HermesSubagentPresentationPolicy.showsPromote(for: activity)
                    ? HermesSubagentPresentationPolicy.promoteTitle
                    : "Finished"
            )
        }

        let grouped: [(Group, [Item])] = [
            (.needsYou, needs.sorted(by: Self.itemOrder)),
            (.active, (
                (HomeInChatActivityProjectionPolicy.includesFleetActivityRows(parentThreadId: parentThreadId) ? active : [])
                    + subagentActive
            ).sorted(by: Self.itemOrder)),
            (.queued, queued),
            (.recentlyFinished, (
                (HomeInChatActivityProjectionPolicy.includesFleetActivityRows(parentThreadId: parentThreadId) ? recentlyFinished : [])
                    + subagentFinished
            ).sorted(by: Self.itemOrder))
        ]
        self.sections = grouped.map { Section(kind: $0.0, items: $0.1) }
        self.items = grouped.flatMap(\.1)
        if !needs.isEmpty {
            self.state = .needsAttention
        } else if !self.items.isEmpty {
            self.state = .active
        } else {
            self.state = .quiet
        }
    }

    private static func itemOrder(_ lhs: Item, _ rhs: Item) -> Bool {
        lhs.timestamp == rhs.timestamp
            ? (lhs.title == rhs.title ? lhs.threadId < rhs.threadId : lhs.title < rhs.title)
            : lhs.timestamp > rhs.timestamp
    }

    private static func messageLine(_ message: Message?) -> String {
        guard let message else { return "Finished" }
        switch message.kind {
        case .text, .unknown:
            return message.text ?? "Finished"
        case .options:
            return message.card?.title ?? "Finished"
        case .activity:
            return message.tool?.name ?? "Finished"
        case .screen:
            return "Screenshot"
        case .connector:
            return message.connector?.label ?? message.text ?? "Finished"
        }
    }
}

public extension CompanionState {
    func homeActivityPresentation(
        queuedReceipts: [HomeActivityQueueReceipt] = [],
        subagents: [HermesSubagentActivity] = [],
        parentThreadId: String? = nil
    ) -> HomeActivityPresentation {
        HomeActivityPresentation(
            state: self,
            queuedReceipts: queuedReceipts,
            subagents: subagents,
            parentThreadId: parentThreadId
        )
    }
}
