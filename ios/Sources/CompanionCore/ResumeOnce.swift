import Foundation

/// Guards a checked continuation so cancellation and completion cannot resume twice.
public final class ResumeOnce<T>: @unchecked Sendable {
    private let continuation: CheckedContinuation<T, Never>
    private let lock = NSLock()
    private var resumed = false

    public init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    public func resume(returning value: T) {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        resumed = true
        continuation.resume(returning: value)
    }

    public var hasResumed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return resumed
    }
}
