import Foundation

/// Fail-closed share-extension post rules. A lock miss or write failure must
/// not open the host app or complete the extension request as success.
public enum ShareExtensionPostPolicy: Sendable {
    public static let busyCopy = "Shared content is busy. Try again."
    public static let genericCopy = "Couldn't save shared content. Try again."

    public enum Decision: Equatable, Sendable {
        case openApp
        case failClosed(message: String)
    }

    public static func decision(saving error: Error?) -> Decision {
        guard let error else { return .openApp }
        if error as? ShareInboxError == .lockUnavailable {
            return .failClosed(message: busyCopy)
        }
        return .failClosed(message: genericCopy)
    }

    public static func message(for error: Error) -> String {
        switch decision(saving: error) {
        case .openApp:
            return busyCopy
        case let .failClosed(message):
            return message
        }
    }

    public static func shouldOpenHost(after error: Error?) -> Bool {
        decision(saving: error) == .openApp
    }

    public static func shouldCompleteSuccess(after error: Error?) -> Bool {
        shouldOpenHost(after: error)
    }

    public static func leavesRequestRetryable(after error: Error?) -> Bool {
        !shouldCompleteSuccess(after: error)
    }
}
