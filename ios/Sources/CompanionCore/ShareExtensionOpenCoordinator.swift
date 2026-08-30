import Foundation

/// Completes a share-extension request exactly once after opening the host app
/// or a short timeout, so a missing open callback cannot hang the extension.
public final class ShareExtensionOpenCoordinator {
    public typealias OpenHandler = (@escaping (Bool) -> Void) -> Void
    public typealias CompleteHandler = () -> Void

    private let timeout: TimeInterval
    private let open: OpenHandler
    private let complete: CompleteHandler
    private let queue: DispatchQueue
    private var finished = false
    private var timeoutWorkItem: DispatchWorkItem?

    public init(
        timeout: TimeInterval = 2.0,
        queue: DispatchQueue = .main,
        open: @escaping OpenHandler,
        complete: @escaping CompleteHandler
    ) {
        self.timeout = timeout
        self.queue = queue
        self.open = open
        self.complete = complete
    }

    public func start() {
        queue.async { [self] in
            guard !finished else { return }
            open { [weak self] _ in
                self?.finish()
            }
            let work = DispatchWorkItem { [weak self] in
                self?.finish()
            }
            timeoutWorkItem = work
            queue.asyncAfter(deadline: .now() + timeout, execute: work)
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        complete()
    }
}
