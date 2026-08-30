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

    func testCancelBeforeAttachResumesOnceAndDoesNotHang() async {
        let gate = ResumeOnce<String?>()
        gate.resume(returning: nil)
        let value = await withCheckedContinuation { continuation in
            gate.attach(continuation)
            gate.resume(returning: "late-callback")
        }
        XCTAssertNil(value)
        XCTAssertTrue(gate.hasResumed)
    }

    func testCancelAndCallbackRaceAfterAttachResumesAtMostOnce() async {
        let gate = ResumeOnce<Int?>()
        let value = await withCheckedContinuation { continuation in
            gate.attach(continuation)
            DispatchQueue.global().async { gate.resume(returning: 1) }
            DispatchQueue.global().async { gate.resume(returning: nil) }
        }
        XCTAssertTrue(value == 1 || value == nil)
        XCTAssertTrue(gate.hasResumed)
    }
}
