import XCTest
@testable import CompanionCore

final class ShareExtensionPostPolicyTests: XCTestCase {
    func testSuccessfulSaveOpensHost() {
        XCTAssertEqual(ShareExtensionPostPolicy.decision(saving: nil), .openApp)
        XCTAssertTrue(ShareExtensionPostPolicy.shouldOpenHost(after: nil))
        XCTAssertTrue(ShareExtensionPostPolicy.shouldCompleteSuccess(after: nil))
    }

    func testLockUnavailableFailsClosedWithBusyCopyAndLeavesRequestOpen() {
        let decision = ShareExtensionPostPolicy.decision(saving: ShareInboxError.lockUnavailable)
        XCTAssertEqual(
            decision,
            .failClosed(message: ShareExtensionPostPolicy.busyCopy)
        )
        XCTAssertEqual(ShareExtensionPostPolicy.busyCopy, "Shared content is busy. Try again.")
        XCTAssertEqual(ShareInboxError.lockUnavailable.errorDescription, ShareExtensionPostPolicy.busyCopy)
        XCTAssertFalse(ShareExtensionPostPolicy.shouldOpenHost(after: ShareInboxError.lockUnavailable))
        XCTAssertFalse(ShareExtensionPostPolicy.shouldCompleteSuccess(after: ShareInboxError.lockUnavailable))
        XCTAssertTrue(ShareExtensionPostPolicy.leavesRequestRetryable(after: ShareInboxError.lockUnavailable))
    }

    func testPathLeakingWriteErrorUsesGenericCopy() {
        let pathError = NSError(
            domain: NSCocoaErrorDomain,
            code: NSFileWriteNoPermissionError,
            userInfo: [
                NSLocalizedDescriptionKey: "Couldn’t save /var/mobile/Containers/Data/secret.jpg",
                NSFilePathErrorKey: "/var/mobile/Containers/Data/secret.jpg",
            ]
        )
        let decision = ShareExtensionPostPolicy.decision(saving: pathError)
        XCTAssertEqual(decision, .failClosed(message: ShareExtensionPostPolicy.genericCopy))
        XCTAssertFalse(ShareExtensionPostPolicy.shouldOpenHost(after: pathError))
        XCTAssertFalse(ShareExtensionPostPolicy.shouldCompleteSuccess(after: pathError))
        XCTAssertTrue(ShareExtensionPostPolicy.leavesRequestRetryable(after: pathError))
        XCTAssertEqual(ShareExtensionPostPolicy.message(for: pathError), ShareExtensionPostPolicy.genericCopy)
        XCTAssertFalse(ShareExtensionPostPolicy.message(for: pathError).contains("/var/mobile"))
        XCTAssertFalse(ShareExtensionPostPolicy.message(for: pathError).contains("secret.jpg"))
    }
}
