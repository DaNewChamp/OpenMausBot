import Foundation
import XCTest
@testable import CompanionCore

private final class ModelRequestStub: URLProtocol {
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

final class ModelClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ModelRequestStub.capturedRequest = nil
        ModelRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ModelRequestStub.self]
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

    func testModelPatchEncodesOnlyInstanceAndModel() throws {
        let data = try JSONEncoder().encode(BotModelPatch(instanceId: "claude", model: "claude-sonnet-5"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["instanceId", "model"])
        XCTAssertEqual(body["instanceId"] as? String, "claude")
        XCTAssertEqual(body["model"] as? String, "claude-sonnet-5")
    }

    func testUpdateModelUsesThePairedSafeRoute() async throws {
        ModelRequestStub.responseBody = Self.botResponse

        let updated = try await client.updateModel(
            botId: "model-bot",
            patch: BotModelPatch(instanceId: "claude", model: "claude-haiku-4-5")
        )

        let request = try XCTUnwrap(ModelRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/model-bot/model")
        let data = try XCTUnwrap(ModelRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["instanceId", "model"])
        XCTAssertEqual(updated.modelSelection.instanceId, "claude")
        XCTAssertEqual(updated.modelSelection.model, "claude-haiku-4-5")
    }

    func testLoadsAdvertisedInstances() async throws {
        ModelRequestStub.responseBody = Data("""
        {"instances":[{
          "instanceId":"claude","driverKind":"claudeAgent","displayName":"Fixture Claude",
          "snapshot":{"state":"available"},
          "models":{"default":"claude-sonnet-5","options":[{"id":"claude-sonnet-5","label":"Claude Sonnet 5"}]}
        }]}
        """.utf8)

        let instances = try await client.instances()

        XCTAssertEqual(ModelRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.url?.path, "/api/instances")
        XCTAssertEqual(instances.map(\.instanceId), ["claude"])
        XCTAssertEqual(instances.first?.pickerTitle, "Fixture Claude")
        XCTAssertEqual(instances.first?.modelLabel(for: "claude-sonnet-5"), "Claude Sonnet 5")
    }

    func testSelectableCatalogDropsEmptyAdvertisementsAndAlignsModels() throws {
        let claude = try decodeInstance("""
        {
          "instanceId":"claude","driverKind":"claudeAgent","displayName":"Claude",
          "snapshot":{"state":"available"},
          "models":{"default":"claude-sonnet-5","options":[
            {"id":"claude-sonnet-5","label":"Claude Sonnet 5"},
            {"id":"claude-haiku-4-5","label":"Claude Haiku 4.5"}
          ]}
        }
        """)
        let ghost = try decodeInstance("""
        {
          "instanceId":"ghost","driverKind":"not-a-real-driver","displayName":"Ghost",
          "snapshot":{"state":"unavailable"},
          "models":{"default":"","options":[]}
        }
        """)
        let unnamed = try decodeInstance("""
        {
          "instanceId":"plain","driverKind":"plainAgent",
          "snapshot":{"state":"available"},
          "models":{"default":"plain-1","options":[{"id":"plain-1","label":"Plain"}]}
        }
        """)

        let selectable = AdvertisedModelCatalog.selectableInstances(from: [ghost, claude, unnamed])
        XCTAssertEqual(selectable.map(\.instanceId), ["claude", "plain"])
        XCTAssertEqual(unnamed.pickerTitle, "plainAgent")

        XCTAssertEqual(
            AdvertisedModelCatalog.alignedModel(instanceId: "claude", currentModel: "claude-haiku-4-5", in: selectable),
            "claude-haiku-4-5"
        )
        XCTAssertEqual(
            AdvertisedModelCatalog.alignedModel(instanceId: "claude", currentModel: "ghost-1", in: selectable),
            "claude-sonnet-5"
        )
        XCTAssertEqual(
            AdvertisedModelCatalog.alignedModel(instanceId: "plain", currentModel: "claude-sonnet-5", in: selectable),
            "plain-1"
        )
    }

    private func decodeInstance(_ json: String) throws -> Instance {
        try JSONDecoder().decode(Instance.self, from: Data(json.utf8))
    }

    private static let botResponse = Data("""
    {"bot":{
      "id":"model-bot","threadId":"model-thread","name":"Scout","title":"Researcher",
      "description":"Finds evidence.","notifications":true,"color":"blue",
      "unread":false,"modelSelection":{"instanceId":"claude","model":"claude-haiku-4-5"},
      "createdAt":1786742441013
    }}
    """.utf8)
}
