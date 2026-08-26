import Foundation

/// The default delivery choice for a message sent while an agent is already
/// working. This is a phone-local preference; the server remains the source
/// of truth for whether a requested mode can be honored.
public enum BusySendDefault: String, Codable, CaseIterable, Sendable {
    case steer
    case queue

    /// Unknown values from a future build are deliberately safe: steering is
    /// the least surprising action and preserves the established behavior.
    public init(rawValue: String) {
        self = rawValue == Self.queue.rawValue ? .queue : .steer
    }

    public var deliveryMode: MessageDeliveryMode {
        switch self {
        case .steer: return .steer
        case .queue: return .queue
        }
    }
}

/// The action shown by the composer's trailing control for the current draft.
public enum ComposerPrimaryAction: Equatable, Sendable {
    case stop
    case send(MessageDeliveryMode)
    case none
}

/// Pure state policy for the composer's primary control. Whitespace-only
/// drafts count as empty so a busy chat never presents a send action that the
/// server would reject.
public enum ComposerActionPolicy {
    public static func action(
        busy: Bool,
        draft: String,
        defaultMode: BusySendDefault
    ) -> ComposerPrimaryAction {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if busy {
            return hasText ? .send(defaultMode.deliveryMode) : .stop
        }
        return hasText ? .send(.auto) : .none
    }
}

/// Small value-type guard shared by send and interrupt requests. Keeping it
/// outside SwiftUI makes the duplicate-submission rule easy to test and
/// avoids relying on button disabled state alone, which can lag one render.
public struct ComposerRequestGate: Sendable {
    public private(set) var isInFlight = false

    public init() {}

    @discardableResult
    public mutating func begin() -> Bool {
        guard !isInFlight else { return false }
        isInFlight = true
        return true
    }

    public mutating func end() {
        isInFlight = false
    }
}
