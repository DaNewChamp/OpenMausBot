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

    func testPagedAuthoritativeRefreshKeepsReceiptMissingFromPartialTranscript() {
        var store = HomeActivityQueueReceiptStore()
        XCTAssertTrue(store.observe(queuedReceipt()))

        var state = CompanionState()
        state.messages["thread-1"] = [message(id: "m-old", queueId: nil)]
        state.hasMore["thread-1"] = true

        store.reconcile(state: state, authoritativeRefresh: true)

        XCTAssertEqual(store.receipts.map(\.queueId), ["q-1"])
    }

    func testUnknownAuthoritativeRefreshKeepsReceiptWhenTranscriptMetadataIsMissing() {
        var store = HomeActivityQueueReceiptStore()
        XCTAssertTrue(store.observe(queuedReceipt()))

        var state = CompanionState()
        state.messages["thread-1"] = []

        store.reconcile(state: state, authoritativeRefresh: true)

        XCTAssertEqual(store.receipts.map(\.queueId), ["q-1"])
    }

    func testCompleteAuthoritativeRefreshRetiresReceiptMissingFromTranscript() {
        var store = HomeActivityQueueReceiptStore()
        XCTAssertTrue(store.observe(queuedReceipt()))

        var state = CompanionState()
        state.messages["thread-1"] = []
        state.hasMore["thread-1"] = false

        store.reconcile(state: state, authoritativeRefresh: true)

        XCTAssertTrue(store.receipts.isEmpty)
    }

    func testHydrateWithoutMessagesOrPaginationMetadataDoesNotClaimAnEmptyTranscript() {
        var state = CompanionState()
        state.hydrate(Fleet(bots: [makeBot()], groups: []))

        XCTAssertNil(state.messages["thread-1"])
        XCTAssertNil(state.hasMore["thread-1"])

        var store = HomeActivityQueueReceiptStore()
        XCTAssertTrue(store.observe(queuedReceipt()))
        store.reconcile(state: state, authoritativeRefresh: true)

        XCTAssertEqual(store.receipts.map(\.queueId), ["q-1"])
    }

    private func queuedReceipt() -> MessageDeliveryReceipt {
        MessageDeliveryReceipt(
            disposition: .queued,
            queueId: "q-1",
            threadId: "thread-1"
        )
    }

    private func makeBot() -> Bot {
        Bot(
            id: "bot-1",
            threadId: "thread-1",
            name: "Scout",
            title: "",
            description: "",
            notifications: true,
            color: "green",
            avatarUrl: nil,
            avatarCrop: nil,
            unread: false,
            modelSelection: ModelSelection(instanceId: "preview", model: "preview"),
            createdAt: 1,
            busy: false,
            pinned: false,
            hidden: false,
            chiefOfStaff: false,
            autoApprove: false,
            alwaysAllow: nil,
            computer: nil,
            cloudBackend: nil,
            speakReplies: false,
            voice: nil,
            mascotExpression: nil,
            tasks: nil,
            messages: nil,
            activeLeafId: nil,
            hasMore: nil
        )
    }

    private func message(id: String, queueId: String?) -> Message {
        var value = Message(id: id, role: .user, kind: .text, at: 2)
        value.text = "queued"
        value.queueId = queueId
        return value
    }
}
