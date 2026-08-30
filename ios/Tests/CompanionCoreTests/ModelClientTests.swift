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

private final class HeldModelRequestStub: URLProtocol {
    static let lock = NSLock()
    static var started = 0
    static var stopped = 0
    static var finished = 0
    static var capturedRequest: URLRequest?
    static var inflight: HeldModelRequestStub?

    private let instanceLock = NSLock()
    private var didStop = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.started += 1
        Self.capturedRequest = request
        Self.inflight = self
        Self.lock.unlock()
    }

    override func stopLoading() {
        instanceLock.lock()
        defer { instanceLock.unlock() }
        guard !didStop else { return }
        didStop = true
        Self.lock.lock()
        Self.stopped += 1
        Self.inflight = nil
        Self.lock.unlock()
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }

    static func reset() {
        lock.lock()
        started = 0
        stopped = 0
        finished = 0
        capturedRequest = nil
        inflight = nil
        lock.unlock()
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

    func testModelPatchEncodesEffortAndCanClearIt() throws {
        let set = try JSONEncoder().encode(
            BotModelPatch(instanceId: "codex", model: "gpt-5.6-sol", effort: .set("high"))
        )
        let setBody = try XCTUnwrap(JSONSerialization.jsonObject(with: set) as? [String: Any])
        XCTAssertEqual(setBody.keys.sorted(), ["effort", "instanceId", "model"])
        XCTAssertEqual(setBody["effort"] as? String, "high")

        let clear = try JSONEncoder().encode(
            BotModelPatch(instanceId: "codex", model: "gpt-5.6-sol", effort: .clear)
        )
        let clearBody = try XCTUnwrap(JSONSerialization.jsonObject(with: clear) as? [String: Any])
        XCTAssertEqual(clearBody.keys.sorted(), ["effort", "instanceId", "model"])
        XCTAssertTrue(clearBody["effort"] is NSNull)
    }

    func testUpdateComputerDestinationUsesThePairedSafeRoute() async throws {
        ModelRequestStub.responseBody = Self.botResponse

        let updated = try await client.updateComputerDestination(
            botId: "model-bot",
            patch: BotComputerDestinationPatch(computer: "vm")
        )
        XCTAssertEqual(updated.id, "model-bot")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.httpMethod, "PATCH")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.url?.path, "/api/bots/model-bot/computer-destination")
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(ModelRequestStub.capturedBody)) as? [String: Any]
        XCTAssertEqual(body?["computer"] as? String, "vm")
        XCTAssertNil(body?["autoApprove"])
        XCTAssertNil(body?["acknowledgeLocalAuto"])
    }

    func testComputerDestinationPatchOmitsUnusedFields() throws {
        let data = try JSONEncoder().encode(BotComputerDestinationPatch(computer: "local", acknowledgeLocalAuto: true))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["acknowledgeLocalAuto", "computer"])
        XCTAssertEqual(body["computer"] as? String, "local")
        XCTAssertEqual(body["acknowledgeLocalAuto"] as? Bool, true)
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
        XCTAssertEqual(updated.modelSelection.effort, "high")
    }

    func testLoadsAdvertisedInstances() async throws {
        ModelRequestStub.responseBody = Data("""
        {"instances":[{
          "instanceId":"claude","driverKind":"claudeAgent","displayName":"Fixture Claude",
          "snapshot":{"state":"available"},
          "models":{"default":"claude-sonnet-5","options":[{"id":"claude-sonnet-5","label":"Claude Sonnet 5"}]},
          "capabilities":{"computerMcp":true,"effortLevels":["low","medium","high","xhigh","max"]}
        }]}
        """.utf8)

        let instances = try await client.instances()

        XCTAssertEqual(ModelRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.url?.path, "/api/instances")
        XCTAssertEqual(instances.map(\.instanceId), ["claude"])
        XCTAssertEqual(instances.first?.pickerTitle, "Fixture Claude")
        XCTAssertEqual(instances.first?.modelLabel(for: "claude-sonnet-5"), "Claude Sonnet 5")
        XCTAssertTrue(instances.first?.supportsLocalVmDestination ?? false)
        XCTAssertEqual(instances.first?.capabilities?.effortLevels, ["low", "medium", "high", "xhigh", "max"])
    }

    func testGrokReconstructedDoesNotSupportLocalVmDestination() {
        let grok = Instance(
            instanceId: "grokReconstructed",
            driverKind: "grokReconstructed",
            displayName: "Grok Reconstructed",
            snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(default: "active", options: [ModelOption(id: "active", label: "Active")]),
            capabilities: InstanceCapabilities(computerMcp: false, localComputerMcp: false)
        )
        XCTAssertFalse(grok.supportsLocalVmDestination)
        XCTAssertTrue(grok.localVmDestinationDisabledReason.contains("Grok Reconstructed"))
    }

    func testUnknownInstanceCapabilitiesAllowLocalVmDestination() {
        let cursor = Instance(
            instanceId: "cursor",
            driverKind: "cursorAgent",
            displayName: "Cursor",
            snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(default: "auto", options: [ModelOption(id: "auto", label: "Auto")]),
            capabilities: nil
        )
        XCTAssertTrue(cursor.supportsLocalVmDestination)
    }

    func testBoxAgentDoesNotSupportLocalVmDestination() {
        let box = Instance(
            instanceId: "box",
            driverKind: "boxAgent",
            displayName: "Computer",
            snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
            models: ModelCatalog(default: "claude-fable-5", options: [ModelOption(id: "claude-fable-5", label: "Claude Fable 5")]),
            capabilities: InstanceCapabilities(computerMcp: true)
        )
        XCTAssertFalse(box.supportsLocalVmDestination)
        XCTAssertTrue(box.localVmDestinationDisabledReason.contains("Cloud Box"))
    }

    func testLocalVmStatusUsesTheSafePerBotRoute() async throws {
        ModelRequestStub.responseBody = Data("""
        {"mode":"per-bot","max_instances":2,"state":"missing","container":"missing",
         "daemon_up":true,"image_ready":true,"desktop_ready":false,"ready":false,
         "create_supported":true,"busy":false,"can_create":true,"can_stop":false,
         "can_recreate":false,"problem":"Create this bot's Local VM."}
        """.utf8)

        let status = try await client.localVmStatus(botId: "model-bot")

        XCTAssertEqual(ModelRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.url?.path, "/api/bots/model-bot/local-computer")
        XCTAssertEqual(status.mode, .perBot)
        XCTAssertTrue(status.canCreate)
    }

    func testLocalVmActionsSendOnlyAnEmptyJsonObject() async throws {
        ModelRequestStub.responseBody = Data("""
        {"mode":"per-bot","max_instances":2,"state":"ready","container":"running",
         "daemon_up":true,"image_ready":true,"desktop_ready":true,"ready":true,
         "create_supported":true,"busy":false,"can_create":false,"can_stop":true,
         "can_recreate":true,"problem":null}
        """.utf8)

        _ = try await client.stopLocalVm(botId: "model-bot")

        XCTAssertEqual(ModelRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.url?.path, "/api/bots/model-bot/local-computer/stop")
        let body = try XCTUnwrap(ModelRequestStub.capturedBody)
        XCTAssertEqual(String(data: body, encoding: .utf8), "{}")
    }

    func testLocalVmScreenshotUsesTheEmptyCaptureRoute() async throws {
        ModelRequestStub.responseBody = Data(#"{"image":"data:image/png;base64,aGVsbG8="}"#.utf8)

        let capture = try await client.localVmScreenshot(botId: "model-bot")

        XCTAssertEqual(ModelRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(ModelRequestStub.capturedRequest?.url?.path, "/api/bots/model-bot/local-computer/screenshot")
        let body = try XCTUnwrap(ModelRequestStub.capturedBody)
        XCTAssertEqual(String(data: body, encoding: .utf8), "{}")
        XCTAssertEqual(capture.image, "data:image/png;base64,aGVsbG8=")
        XCTAssertEqual(ScreenFrame.fromCapture(capture.image)?.png, "aGVsbG8=")
    }

    func testSelectableCatalogKeepsEveryAdvertisedInstanceAndAlignsModelsOnSwitch() throws {
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

        let advertised = AdvertisedModelCatalog.advertisedInstances(from: [ghost, claude, unnamed])
        XCTAssertEqual(advertised.map(\.instanceId), ["ghost", "claude", "plain"])
        XCTAssertEqual(AdvertisedModelCatalog.selectableInstances(from: advertised).map(\.instanceId), ["claude", "plain"])
        XCTAssertEqual(unnamed.pickerTitle, "plainAgent")
        XCTAssertFalse(AdvertisedModelCatalog.isEmpty(advertised))
        XCTAssertTrue(AdvertisedModelCatalog.isEmpty([ghost]))

        XCTAssertEqual(
            AdvertisedModelCatalog.alignedModel(instanceId: "claude", currentModel: "claude-haiku-4-5", in: advertised),
            "claude-haiku-4-5"
        )
        XCTAssertEqual(
            AdvertisedModelCatalog.alignedModel(instanceId: "claude", currentModel: "ghost-1", in: advertised),
            "claude-sonnet-5"
        )
        XCTAssertEqual(
            AdvertisedModelCatalog.alignedModel(instanceId: "plain", currentModel: "claude-sonnet-5", in: advertised),
            "plain-1"
        )

        let selection = ModelSelection(instanceId: "claude", model: "retired-model")
        XCTAssertEqual(
            AdvertisedModelCatalog.preservedSelection(selection, in: advertised),
            selection
        )
        XCTAssertEqual(
            AdvertisedModelCatalog.humanModelLabel(selection: ModelSelection(instanceId: "claude", model: "claude-sonnet-5"), instances: advertised),
            "Claude Sonnet 5"
        )
        XCTAssertEqual(AdvertisedModelCatalog.displayModelLabel("gpt-5.6-sol"), "Gpt 5.6 Sol")
        XCTAssertEqual(AdvertisedModelCatalog.displayModelLabel("auto"), "Auto")
    }

    func testAdvertisedInstancesWithoutSelectableFlagsStayChangeable() throws {
        let instance = try decodeInstance("""
        {
          "instanceId":"plain","driverKind":"plainAgent",
          "snapshot":{"state":"available"},
          "models":{"default":"plain-1","options":[{"id":"plain-1","label":"Plain"}]}
        }
        """)
        XCTAssertNil(instance.instanceSelectable)
        XCTAssertNil(instance.modelSelectable)
        XCTAssertTrue(instance.allowsInstanceChange)
        XCTAssertTrue(instance.allowsModelChange)
    }

    func testMissingInstanceStaysVisibleAsUnavailableOrphan() {
        let advertised = [
            Instance(
                instanceId: "plain",
                driverKind: "plainAgent",
                displayName: "Plain",
                snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
                models: ModelCatalog(default: "plain-1", options: [ModelOption(id: "plain-1", label: "Plain")])
            )
        ]
        let selection = ModelSelection(instanceId: "retired", model: "retired-1")
        XCTAssertTrue(EngineSyncPolicy.instanceDisappeared(selectedId: selection.instanceId, advertised: advertised))
        let catalog = AdvertisedModelCatalog.displayCatalog(advertised: advertised, selection: selection)
        XCTAssertEqual(catalog.map(\.instanceId), ["plain", "retired"])
        XCTAssertFalse(catalog[1].allowsInstanceChange)
        XCTAssertFalse(catalog[1].snapshot.isAvailable)
        XCTAssertEqual(catalog[1].chipModelLabel(selectedInstanceId: "retired", selectedModel: "retired-1"), "Retired 1")
    }

    func testReconstructedProvidersPreserveSelectableFlagsWithoutVendorFilter() throws {
        let catalog = try JSONDecoder().decode(
            VBotProviderCatalog.self,
            from: Data("""
            {
              "scope":"host","perBotSelection":false,
              "currentProvider":"alpha","currentModelId":"alpha-1",
              "providers":[
                {"id":"alpha","label":"Alpha","current":true,"selectable":true,"modelSelectable":true,
                 "models":[{"id":"alpha-1","current":true,"selectable":true}]},
                {"id":"beta","label":"Beta","current":false,"selectable":true,"modelSelectable":false,
                 "models":[{"id":"local","current":true,"selectable":false}]}
              ]
            }
            """.utf8)
        )
        let instances = catalog.asInstances
        XCTAssertEqual(instances.map(\.instanceId), ["alpha", "beta"])
        XCTAssertEqual(instances.map(\.allowsModelChange), [true, false])
        XCTAssertEqual(instances[1].models.options.map(\.id), ["local"])
        XCTAssertTrue(instances[1].allowsInstanceChange)
    }

    func testCancelledUpdateModelDoesNotCommitResponse() async {
        HeldModelRequestStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldModelRequestStub.self]
        let gatedSession = URLSession(configuration: configuration)
        let gatedClient = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: gatedSession
        )
        defer {
            gatedSession.invalidateAndCancel()
        }

        let task = Task {
            try await gatedClient.updateModel(
                botId: "model-bot",
                patch: BotModelPatch(instanceId: "claude", model: "claude-haiku-4-5")
            )
        }
        let started = await waitUntil { HeldModelRequestStub.started > 0 }
        XCTAssertTrue(started, "updateModel should create a request before cancel")
        XCTAssertEqual(HeldModelRequestStub.finished, 0)

        task.cancel()
        _ = await waitUntil { HeldModelRequestStub.stopped > 0 }
        var committed: Bot?
        do {
            committed = try await task.value
            XCTFail("cancelled updateModel committed \(String(describing: committed))")
        } catch {
            XCTAssertTrue(
                error is CancellationError || error.isCancellation,
                "expected cancellation, got \(error)"
            )
        }
        XCTAssertNil(committed)
        XCTAssertEqual(HeldModelRequestStub.finished, 0)
    }

    func testCancelledRouterWriteDoesNotCommitResponse() async {
        HeldModelRequestStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldModelRequestStub.self]
        let gatedSession = URLSession(configuration: configuration)
        let gatedClient = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: gatedSession
        )
        defer {
            gatedSession.invalidateAndCancel()
        }

        let task = Task {
            try await gatedClient.setReconstructedRouter(
                VBotRouterPatch(provider: "alpha", modelId: "alpha-1")
            )
        }
        let started = await waitUntil { HeldModelRequestStub.started > 0 }
        XCTAssertTrue(started, "setReconstructedRouter should create a request before cancel")
        XCTAssertEqual(HeldModelRequestStub.finished, 0)

        task.cancel()
        _ = await waitUntil { HeldModelRequestStub.stopped > 0 }
        var committed: VBotRouterState?
        do {
            committed = try await task.value
            XCTFail("cancelled setReconstructedRouter committed \(String(describing: committed))")
        } catch {
            XCTAssertTrue(
                error is CancellationError || error.isCancellation,
                "expected cancellation, got \(error)"
            )
        }
        XCTAssertNil(committed)
        XCTAssertEqual(HeldModelRequestStub.finished, 0)
    }

    func testCancelledUpdateModelBeforeSendDoesNotStartRequest() async {
        HeldModelRequestStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldModelRequestStub.self]
        let gatedSession = URLSession(configuration: configuration)
        let gatedClient = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: gatedSession
        )
        defer {
            gatedSession.invalidateAndCancel()
        }

        let task = Task {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            return try await gatedClient.updateModel(
                botId: "model-bot",
                patch: BotModelPatch(instanceId: "claude", model: "claude-haiku-4-5")
            )
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("cancelled task should not send updateModel")
        } catch {
            XCTAssertTrue(error is CancellationError || error.isCancellation)
        }
        XCTAssertEqual(HeldModelRequestStub.started, 0)
        XCTAssertEqual(HeldModelRequestStub.finished, 0)
    }

    private func decodeInstance(_ json: String) throws -> Instance {
        try JSONDecoder().decode(Instance.self, from: Data(json.utf8))
    }

    private static let botResponse = Data("""
    {"bot":{
      "id":"model-bot","threadId":"model-thread","name":"Scout","title":"Researcher",
      "description":"Finds evidence.","notifications":true,"color":"blue",
      "unread":false,"modelSelection":{"instanceId":"claude","model":"claude-haiku-4-5","effort":"high"},
      "createdAt":1786742441013
    }}
    """.utf8)
}

private func waitUntil(
    timeoutNanoseconds: UInt64 = 2_000_000_000,
    _ condition: @Sendable () -> Bool
) async -> Bool {
    let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
    while DispatchTime.now().uptimeNanoseconds < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}
