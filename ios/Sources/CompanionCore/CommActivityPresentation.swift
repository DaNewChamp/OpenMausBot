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
    /// Canonical channel message to scroll to when opening from a comm chip.
    public let focusMessageId: String?
    /// Whether the companion currently has a room it can open for this
    /// exchange. A missing room is still useful context, but it must not
    /// present a dead navigation affordance.
    public let destinationAvailable: Bool
    public let showsRunning = false

    public init?(message: Message, destinationAvailable: Bool = true) {
        guard message.kind == .activity, let comm = message.comm else { return nil }
        peerBotId = comm.withBotId
        let candidate = message.tool?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        title = candidate.isEmpty ? "Messaged @\(comm.withName)" : candidate
        groupId = comm.groupId
        focusMessageId = comm.messageId
        self.destinationAvailable = destinationAvailable
    }

    /// A few provider versions emit a short assistant text such as
    /// "Messaged CIO" alongside the richer comm activity that the harness
    /// writes for the same handoff. The activity already carries the peer
    /// avatar and destination, so drawing both rows is visual duplication.
    /// Keep the check deliberately narrow: only an un-attributed bot text
    /// that exactly names a neighbouring comm activity can be compacted.
    public static func shouldSuppressNarration(
        _ message: Message,
        in transcript: [Message],
        at index: Int
    ) -> Bool {
        guard transcript.indices.contains(index),
              transcript[index].id == message.id,
              message.kind == .text,
              message.role == .bot,
              message.from == nil,
              message.comm == nil,
              message.card == nil,
              message.tool == nil,
              message.reactions?.isEmpty ?? true,
              let text = normalized(message.text),
              !text.isEmpty
        else { return false }

        let lowerBound = max(transcript.startIndex, index - 2)
        let upperBound = min(transcript.index(before: transcript.endIndex), index + 2)
        guard lowerBound <= upperBound else { return false }

        for candidateIndex in lowerBound...upperBound where candidateIndex != index {
            let candidate = transcript[candidateIndex]
            guard candidate.kind == .activity,
                  candidate.role == .bot,
                  let comm = candidate.comm,
                  candidate.tool?.ok != false
            else { continue }

            let candidateTitle = normalized(candidate.tool?.name)
                ?? normalized("Messaged @\(comm.withName)")
            guard let candidateTitle else { continue }

            let directlyRelated = message.parentId == candidate.id || candidate.parentId == message.id
            let closeInTime = abs(message.at - candidate.at) <= 30_000
            guard directlyRelated || closeInTime else { continue }
            if text == candidateTitle { return true }
        }
        return false
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let collapsed = value
            .replacingOccurrences(of: "@", with: "")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return collapsed.isEmpty ? nil : collapsed
    }
}
