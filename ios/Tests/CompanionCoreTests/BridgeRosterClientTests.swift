import Foundation
import XCTest
@testable import CompanionCore

private final class BridgeRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class BridgeRosterClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        BridgeRequestStub.responseBody = Data()
        BridgeRequestStub.statusCode = 200
        BridgeRequestStub.capturedRequest = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BridgeRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session?.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testListsRegisteredBridgesWithoutSecrets() async throws {
        BridgeRequestStub.responseBody = Data(
            #"{"bridges":[{"id":"br-mini","name":"mini","capabilities":["shell","local-vm"],"grantedCapabilities":["shell"],"createdAt":1,"lastSeenAt":2,"online":true}]}"#.utf8
        )

        let bridges = try await client.bridgeRoster()

        XCTAssertEqual(BridgeRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(BridgeRequestStub.capturedRequest?.url?.path, "/api/bridges")
        XCTAssertEqual(
            BridgeRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
        XCTAssertEqual(bridges.count, 1)
        XCTAssertEqual(bridges[0].id, "br-mini")
        XCTAssertEqual(bridges[0].name, "mini")
        XCTAssertEqual(bridges[0].capabilities, ["shell", "local-vm"])
        XCTAssertTrue(bridges[0].online)
    }

    func testDecodesUnknownBridgeFieldsWithoutCrashing() throws {
        let data = Data(
            #"{"bridges":[{"id":"br-1","name":"office","capabilities":["ssh-forward"],"grantedCapabilities":[],"createdAt":1,"lastSeenAt":2,"hostInfo":"darwin","online":false,"tokenHash":"must-not-decode"}]}"#.utf8
        )
        let decoded = try JSONDecoder().decode(BridgeRosterResponse.self, from: data)
        XCTAssertEqual(decoded.bridges.count, 1)
        XCTAssertEqual(decoded.bridges[0].hostInfo, "darwin")
        XCTAssertFalse(decoded.bridges[0].online)
    }
}
