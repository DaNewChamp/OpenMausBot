import XCTest
@testable import CompanionCore

final class ResumeOnceTests: XCTestCase {
    func testResumesOnlyOnceWhenCompletionAndCancellationRace() async {
        let value = await withCheckedContinuation { continuation in
            let gate = ResumeOnce<Int>(continuation)
            gate.resume(returning: 1)
            gate.resume(returning: 2)
            XCTAssertTrue(gate.hasResumed)
        }
        XCTAssertEqual(value, 1)
    }

    func testCancellationResumeDoesNotDoubleResumeAfterCompletion() async {
        let value = await withCheckedContinuation { continuation in
            let gate = ResumeOnce<String?>(continuation)
            gate.resume(returning: "done")
            gate.resume(returning: nil)
            XCTAssertTrue(gate.hasResumed)
        }
        XCTAssertEqual(value, "done")
    }
}
