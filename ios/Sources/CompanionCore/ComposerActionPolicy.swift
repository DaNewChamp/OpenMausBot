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

public struct EngineComposerCapabilities: Equatable, Sendable {
    public var queueing: Bool
    public var steer: Bool
    public var stop: Bool

    public static let openmaus = EngineComposerCapabilities(queueing: true, steer: true, stop: true)

    public init(queueing: Bool, steer: Bool, stop: Bool) {
        self.queueing = queueing
        self.steer = steer
        self.stop = stop
    }

    public init(_ capabilities: VBotModelCapabilities) {
        self.queueing = capabilities.queueing
        self.steer = capabilities.steer
        // Reconstructed payloads from older desktops may omit `stop`. An
        // omitted mutation capability must fail closed; OpenMaus payloads
        // advertise the field explicitly.
        self.stop = capabilities.stop == true
    }
}

public enum VBotMutationRouting {
    public static func target(for sync: VBotEngineSync?) -> VBotPrimaryEngine {
        sync?.usesReconstructedMutations == true ? .grokReconstructed : .openmaus
    }

    public static func composerCapabilities(for sync: VBotEngineSync?) -> EngineComposerCapabilities {
        guard target(for: sync) == .grokReconstructed else { return .openmaus }
        guard sync?.reconstructedMutationsReady == true,
              let capabilities = sync?.modelCapabilities
        else { return EngineComposerCapabilities(queueing: false, steer: false, stop: false) }
        return EngineComposerCapabilities(capabilities)
    }
}

/// Pure state policy for the composer's primary control. Whitespace-only
/// drafts count as empty so a busy chat never presents a send action that the
/// server would reject.
public enum ComposerActionPolicy {
    public static func action(
        busy: Bool,
        draft: String,
        defaultMode: BusySendDefault,
        capabilities: EngineComposerCapabilities = .openmaus
    ) -> ComposerPrimaryAction {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if busy {
            if hasText {
                return .send(deliveryMode(defaultMode: defaultMode, capabilities: capabilities))
            }
            return capabilities.stop ? .stop : .none
        }
        return hasText ? .send(.auto) : .none
    }

    public static func deliveryMode(
        defaultMode: BusySendDefault,
        capabilities: EngineComposerCapabilities
    ) -> MessageDeliveryMode {
        switch defaultMode {
        case .queue:
            if capabilities.queueing { return .queue }
            return capabilities.steer ? .steer : .auto
        case .steer:
            return capabilities.steer ? .steer : .auto
        }
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
