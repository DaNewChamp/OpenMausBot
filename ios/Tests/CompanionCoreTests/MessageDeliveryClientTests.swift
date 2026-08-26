import Foundation
import XCTest
@testable import CompanionCore

private final class MessageDeliveryRequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 202, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class MessageDeliveryClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        MessageDeliveryRequestStub.responseBody = Data(#"{"ok":true,"disposition":"queued","queueId":"q-1","threadId":"t-1"}"#.utf8)
        MessageDeliveryRequestStub.capturedRequest = nil
        MessageDeliveryRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MessageDeliveryRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testSendReturnsTypedQueueReceiptAndEncodesDeliveryMode() async throws {
        let receipt = try await client.send(text: "hold this", toBot: "bot-1", mode: .queue)

        XCTAssertEqual(receipt.ok, true)
        XCTAssertEqual(receipt.disposition, .queued)
        XCTAssertEqual(receipt.queueId, "q-1")
        XCTAssertEqual(receipt.threadId, "t-1")
        let request = try XCTUnwrap(MessageDeliveryRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/messages")
        let data = try XCTUnwrap(MessageDeliveryRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["delivery", "text"])
        XCTAssertEqual(body["delivery"] as? String, "queue")
        XCTAssertEqual(body["text"] as? String, "hold this")
    }

    func testRoomInterruptUsesThePairedSafeRoute() async throws {
        MessageDeliveryRequestStub.responseBody = Data(#"{"ok":true}"#.utf8)

        try await client.interrupt(roomId: "room-1")

        let request = try XCTUnwrap(MessageDeliveryRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/groups/room-1/interrupt")
    }

    func testLegacyAcknowledgementDefaultsToStarted() async throws {
        MessageDeliveryRequestStub.responseBody = Data(#"{"ok":true}"#.utf8)

        let receipt = try await client.send(text: "hello", toRoom: "room-1")

        XCTAssertEqual(receipt.disposition, .started)
        XCTAssertNil(receipt.queueId)
        XCTAssertNil(receipt.threadId)
    }

    func testLegacyQueuedAcknowledgementInfersQueuedDisposition() async throws {
        MessageDeliveryRequestStub.responseBody = Data(#"{"ok":true,"queued":true,"queueId":"legacy-q","threadId":"legacy-t"}"#.utf8)

        let receipt = try await client.send(text: "hold this", toBot: "bot-1")

        XCTAssertEqual(receipt.disposition, .queued)
        XCTAssertEqual(receipt.queueId, "legacy-q")
        XCTAssertEqual(receipt.threadId, "legacy-t")
    }

    func testLegacyQueuedAcknowledgementInfersQueuedFromQueueId() async throws {
        MessageDeliveryRequestStub.responseBody = Data(#"{"ok":true,"queueId":"legacy-q"}"#.utf8)

        let receipt = try await client.send(text: "hold this", toRoom: "room-1")

        XCTAssertEqual(receipt.disposition, .queued)
        XCTAssertEqual(receipt.queueId, "legacy-q")
    }

    func testLegacySteeredAcknowledgementInfersSteeredDisposition() async throws {
        MessageDeliveryRequestStub.responseBody = Data(#"{"ok":true,"steered":true}"#.utf8)

        let receipt = try await client.send(text: "urgent", toBot: "bot-1")

        XCTAssertEqual(receipt.disposition, .steered)
        XCTAssertNil(receipt.queueId)
        XCTAssertNil(receipt.threadId)
    }
}
