import XCTest
@testable import CompanionCore

final class HomeActivityQueueReceiptStoreTests: XCTestCase {
    func testSuccessfulQueuedReceiptsAreVisibleUntilTheirQueuedMessageLands() {
        var store = HomeActivityQueueReceiptStore()
        let receipt = MessageDeliveryReceipt(
            disposition: .queued,
            queueId: "q-1",
            threadId: "thread-1"
        )

        XCTAssertTrue(store.observe(receipt))
        XCTAssertEqual(store.receipts.map(\.queueId), ["q-1"])

        store.reconcile(
            threadId: "thread-1",
            transcript: [message(id: "m-1", queueId: "q-1")]
        )

        XCTAssertTrue(store.receipts.isEmpty)
    }

    func testFailedOrNonQueuedOutcomesDoNotInventOrClearLocalQueueTruth() {
        var store = HomeActivityQueueReceiptStore()
        let queued = MessageDeliveryReceipt(
            disposition: .queued,
            queueId: "q-1",
            threadId: "thread-1"
        )
        XCTAssertTrue(store.observe(queued))

        let failed = MessageDeliveryReceipt(
            ok: false,
            disposition: .queued,
            queueId: "q-failed",
            threadId: "thread-1"
        )
        XCTAssertFalse(store.observe(failed))

        let newerOutcome = MessageDeliveryReceipt(ok: true, disposition: .started)
        XCTAssertFalse(store.observe(newerOutcome))
        XCTAssertEqual(store.receipts.map(\.queueId), ["q-1"])
    }

    func testAuthoritativeRefreshRetiresReceiptMissingFromServerTranscript() {
        var store = HomeActivityQueueReceiptStore()
        XCTAssertTrue(
            store.observe(
                MessageDeliveryReceipt(
                    disposition: .queued,
                    queueId: "q-1",
                    threadId: "thread-1"
                )
            )
        )

        store.reconcile(
            threadId: "thread-1",
            transcript: [],
            authoritativeRefresh: true
        )

        XCTAssertTrue(store.receipts.isEmpty)
    }

    private func message(id: String, queueId: String?) -> Message {
        var value = Message(id: id, role: .user, kind: .text, at: 2)
        value.text = "queued"
        value.queueId = queueId
        return value
    }
}
