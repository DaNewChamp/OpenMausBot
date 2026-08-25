import Foundation

/// The renderer-neutral description of a bot-to-bot communication activity.
///
/// Communication rows are a navigation affordance rather than a running tool
/// receipt: the activity is already settled by the time it reaches the
/// transcript, and tapping it opens the room where the exchange lives.
public struct CommActivityPresentation: Equatable, Sendable {
    public let peerBotId: String
    public let title: String
    public let groupId: String
    public let showsRunning = false

    public init?(message: Message) {
        guard message.kind == .activity, let comm = message.comm else { return nil }
        peerBotId = comm.withBotId
        let candidate = message.tool?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        title = candidate.isEmpty ? "Messaged @\(comm.withName)" : candidate
        groupId = comm.groupId
    }
}
