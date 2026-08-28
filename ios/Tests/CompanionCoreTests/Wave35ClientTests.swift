import Foundation
import XCTest
@testable import CompanionCore

private final class Wave35RequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
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

final class Wave35ClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        Wave35RequestStub.responseBody = Data()
        Wave35RequestStub.capturedRequest = nil
        Wave35RequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Wave35RequestStub.self]
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

    func testUpdateGroupSetupUsesNarrowRoute() async throws {
        Wave35RequestStub.responseBody = Data(
            #"{"group":{"id":"room-1","threadId":"t1","name":"Ops","memberIds":["a"],"defaultResponder":{"kind":"mentions"},"bulletin":"Be concise","unread":false,"createdAt":0}}"#.utf8
        )

        let room = try await client.updateGroupSetup(
            roomId: "room-1",
            bulletin: "Be concise",
            defaultResponder: GroupResponder(kind: "mentions", botId: nil)
        )

        XCTAssertEqual(room.id, "room-1")
        XCTAssertEqual(room.bulletin, "Be concise")
        let request = try XCTUnwrap(Wave35RequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/groups/room-1/setup")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(Wave35RequestStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["bulletin"] as? String, "Be concise")
        XCTAssertEqual((body["defaultResponder"] as? [String: Any])?["kind"] as? String, "mentions")
    }

    func testSetBotHiddenUsesVisibilityRoute() async throws {
        Wave35RequestStub.responseBody = Data(
            #"{"bot":{"id":"bot-1","threadId":"t1","name":"Ada","title":"","description":"","notifications":true,"color":"blue","unread":false,"modelSelection":{"instanceId":"claude","model":"claude-haiku-4-5"},"createdAt":0,"hidden":true}}"#.utf8
        )

        let bot = try await client.setBotHidden(botId: "bot-1", hidden: true)

        XCTAssertEqual(bot.hidden, true)
        let request = try XCTUnwrap(Wave35RequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/visibility")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(Wave35RequestStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["hidden"] as? Bool, true)
    }

    func testMarkBotUnreadPostsEmptyObject() async throws {
        Wave35RequestStub.responseBody = Data(#"{"ok":true}"#.utf8)

        try await client.markBotUnread(botId: "bot-1")

        let request = try XCTUnwrap(Wave35RequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/unread")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(Wave35RequestStub.capturedBody)) as? [String: Any])
        XCTAssertTrue(body.isEmpty)
    }

    func testMarkRoomUnreadPostsEmptyObject() async throws {
        Wave35RequestStub.responseBody = Data(#"{"ok":true}"#.utf8)

        try await client.markRoomUnread(roomId: "room-2")

        let request = try XCTUnwrap(Wave35RequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/groups/room-2/unread")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(Wave35RequestStub.capturedBody)) as? [String: Any])
        XCTAssertTrue(body.isEmpty)
    }
}
