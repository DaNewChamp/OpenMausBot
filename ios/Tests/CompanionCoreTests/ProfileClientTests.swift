import Foundation
import XCTest
@testable import CompanionCore

private final class ProfileRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var responseSequence: [(statusCode: Int, body: Data)] = []
    static var transportError: Error?
    static var capturedRequest: URLRequest?
    static var capturedRequests: [URLRequest] = []
    static var capturedBody: Data?
    static var capturedBodies: [Data?] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedRequests.append(request)
        let body = Self.readBody(from: request)
        Self.capturedBody = body
        Self.capturedBodies.append(body)
        if let error = Self.transportError {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let payload = Self.responseSequence.isEmpty
            ? (statusCode: Self.statusCode, body: Self.responseBody)
            : Self.responseSequence.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: payload.statusCode, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload.body)
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

final class ProfileClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ProfileRequestStub.capturedRequest = nil
        ProfileRequestStub.capturedRequests = []
        ProfileRequestStub.capturedBody = nil
        ProfileRequestStub.capturedBodies = []
        ProfileRequestStub.statusCode = 200
        ProfileRequestStub.responseSequence = []
        ProfileRequestStub.transportError = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfileRequestStub.self]
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

    func testProfilePatchPreservesServerLimitsWithoutClientTruncation() throws {
        let name = String(repeating: "n", count: 100)
        let title = String(repeating: "t", count: 200)
        let description = String(repeating: "d", count: 4_000)
        let data = try JSONEncoder().encode(BotProfilePatch(
            name: name, title: title, description: description, voice: ""
        ))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(body["name"] as? String, name)
        XCTAssertEqual(body["title"] as? String, title)
        XCTAssertEqual(body["description"] as? String, description)
        XCTAssertEqual(body["voice"] as? String, "", "empty explicitly selects the workspace default")
    }

    func testProfileClientSendsOnlyFieldsOwnedByTheAction() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(avatarCrop: .rounded)
        )

        _ = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["avatarCrop"])
        XCTAssertEqual(body["avatarCrop"] as? String, "rounded")
    }

    func testProfileClientKeepsAvatarCropPendingWhenServerEchoesMascot() async throws {
        ProfileRequestStub.responseBody = Data(
            Self.botResponseString
                .replacingOccurrences(of: #""avatarCrop":"rounded""#, with: #""avatarCrop":"mascot""#)
                .utf8
        )

        let result = try await client.updateProfileWithCompatibility(
            botId: "avatar-bot",
            patch: BotProfilePatch(
                avatarUrl: .set("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp"),
                avatarCrop: .circle
            )
        )

        guard case let .updatedWithPendingAppearance(updated, fields) = result else {
            return XCTFail("an omitted crop must stay pending so the home roster can show the photo")
        }
        XCTAssertEqual(updated.avatarCrop, .mascot)
        XCTAssertEqual(fields, ["avatarCrop"])
    }

    func testCancelledTransportIsRecognizedAsCancellation() {
        XCTAssertTrue(APIError.transport("cancelled").isCancellation)
        XCTAssertTrue(APIError.transport("canceled").isCancellation)
        XCTAssertTrue(URLError(.cancelled).isCancellation)
        XCTAssertTrue(CancellationError().isCancellation)
        XCTAssertFalse(APIError.transport("This computer is offline.").isCancellation)
        XCTAssertFalse(APIError.status(code: 409, message: "cancelled").isCancellation)
        XCTAssertTrue(RequestCancellation.matches("cancelled"))
    }

    func testProfileClientEncodesCharacterColorAndMascotShape() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(color: "purple", mascotShape: .hexagon)
        )

        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["color", "mascotShape"])
        XCTAssertEqual(body["color"] as? String, "purple")
        XCTAssertEqual(body["mascotShape"] as? String, "hexagon")
    }

    func testProfileClientFallsBackToLegacyBotPatchForExplicitUnsupportedAppearance() async throws {
        ProfileRequestStub.responseSequence = [
            (400, Data(#"{"error":"Unsupported profile field: color"}"#.utf8)),
            (200, Self.botResponseWithPurpleHexagon),
        ]

        let result = try await client.updateProfileWithCompatibility(
            botId: "avatar-bot",
            patch: BotProfilePatch(color: "purple", mascotShape: .hexagon)
        )

        guard case let .updated(updated) = result else {
            return XCTFail("the legacy route should preserve an authoritative update")
        }
        XCTAssertEqual(updated.id, "avatar-bot")
        XCTAssertEqual(
            ProfileRequestStub.capturedRequests.compactMap { $0.url?.path },
            ["/api/bots/avatar-bot/profile", "/api/bots/avatar-bot"]
        )
        let data = try XCTUnwrap(ProfileRequestStub.capturedBodies.last ?? nil)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["color", "mascotShape"])
    }

    func testProfileClientKeepsOnlySilentlyIgnoredLegacyAppearancePending() async throws {
        ProfileRequestStub.responseSequence = [
            (400, Data(#"{"error":"unsupported profile field: color"}"#.utf8)),
            (200, Self.botResponseWithPurpleAndNoShape),
        ]

        let result = try await client.updateProfileWithCompatibility(
            botId: "avatar-bot",
            patch: BotProfilePatch(color: "purple", mascotShape: .hexagon)
        )

        guard case let .updatedWithPendingAppearance(updated, fields) = result else {
            return XCTFail("a legacy route that ignores shape must keep only shape pending")
        }
        XCTAssertEqual(updated.color, "purple")
        XCTAssertNil(updated.mascotShape)
        XCTAssertEqual(fields, ["mascotShape"])
    }

    func testProfileClientDoesNotFallbackForAuthenticationFailure() async throws {
        ProfileRequestStub.responseSequence = [
            (401, Data(#"{"error":"not paired"}"#.utf8)),
        ]

        do {
            _ = try await client.updateProfileWithCompatibility(
                botId: "avatar-bot",
                patch: BotProfilePatch(color: "purple")
            )
            XCTFail("authentication failures must not trigger the broad route")
        } catch let error as APIError {
            guard case let .status(code, message) = error else {
                return XCTFail("unexpected API error: \(error)")
            }
            XCTAssertEqual(code, 401)
            XCTAssertEqual(message, "not paired")
        }
        XCTAssertEqual(ProfileRequestStub.capturedRequests.count, 1)
    }

    func testProfileClientDoesNotFallbackForArbitraryValidationFailure() async throws {
        ProfileRequestStub.responseSequence = [
            (400, Data(#"{"error":"color must be green"}"#.utf8)),
        ]

        do {
            _ = try await client.updateProfileWithCompatibility(
                botId: "avatar-bot",
                patch: BotProfilePatch(color: "purple")
            )
            XCTFail("validation failures must not trigger the broad route")
        } catch let error as APIError {
            guard case let .status(code, message) = error else {
                return XCTFail("unexpected API error: \(error)")
            }
            XCTAssertEqual(code, 400)
            XCTAssertEqual(message, "color must be green")
        }
        XCTAssertEqual(ProfileRequestStub.capturedRequests.count, 1)
    }

    func testProfileClientDoesNotFallbackForTransportFailure() async throws {
        ProfileRequestStub.transportError = URLError(.timedOut)

        do {
            _ = try await client.updateProfileWithCompatibility(
                botId: "avatar-bot",
                patch: BotProfilePatch(color: "purple")
            )
            XCTFail("transport failures must not trigger the broad route")
        } catch let error as APIError {
            guard case .transport = error else {
                return XCTFail("unexpected API error: \(error)")
            }
        }
        XCTAssertEqual(ProfileRequestStub.capturedRequests.count, 1)
    }

    func testProfileClientRetainsAppearanceWhenLegacyRouteIsForbidden() async throws {
        ProfileRequestStub.responseSequence = [
            (400, Data(#"{"error":"unsupported profile field: color"}"#.utf8)),
            (403, Data(#"{"error":"forbidden: route not allowed"}"#.utf8)),
        ]

        let result = try await client.updateProfileWithCompatibility(
            botId: "avatar-bot",
            patch: BotProfilePatch(color: "purple")
        )

        guard case let .pendingAppearance(fields) = result else {
            return XCTFail("a policy-denied legacy route should leave appearance pending")
        }
        XCTAssertEqual(fields, ["color"])
        XCTAssertEqual(
            ProfileRequestStub.capturedRequests.compactMap { $0.url?.path },
            ["/api/bots/avatar-bot/profile", "/api/bots/avatar-bot"]
        )
    }

    func testProfileClientStillSavesOtherFieldsWhenAppearanceIsPending() async throws {
        ProfileRequestStub.responseSequence = [
            (400, Data(#"{"error":"unsupported profile field: color"}"#.utf8)),
            (403, Data(#"{"error":"forbidden: route not allowed"}"#.utf8)),
            (200, Self.botResponse),
        ]

        let result = try await client.updateProfileWithCompatibility(
            botId: "avatar-bot",
            patch: BotProfilePatch(name: "Updated", color: "purple")
        )

        guard case let .updatedWithPendingAppearance(updated, fields) = result else {
            return XCTFail("safe identity fields should still be saved")
        }
        XCTAssertEqual(updated.id, "avatar-bot")
        XCTAssertEqual(fields, ["color"])
        XCTAssertEqual(
            ProfileRequestStub.capturedRequests.compactMap { $0.url?.path },
            ["/api/bots/avatar-bot/profile", "/api/bots/avatar-bot", "/api/bots/avatar-bot/profile"]
        )
        let data = try XCTUnwrap(ProfileRequestStub.capturedBodies.last ?? nil)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["name"])
    }

    func testProfileClientDecodesAnUnknownMascotShapeToTheSafeDefault() async throws {
        ProfileRequestStub.responseBody = Data(
            Self.botResponseString
                .replacingOccurrences(of: #""mascotShape":"hexagon""#, with: #""mascotShape":"star""#)
                .utf8
        )

        let updated = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(color: "purple", mascotShape: .hexagon)
        )

        XCTAssertEqual(updated.mascotShape, .droplet)
    }

    func testProfileClientEncodesAnExplicitAvatarClearAsNull() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot)
        )

        _ = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["avatarCrop", "avatarUrl"])
        XCTAssertTrue(body["avatarUrl"] is NSNull)
        XCTAssertEqual(body["avatarCrop"] as? String, "mascot")
    }

    func testBotPinClientSendsOnlyThePinnedField() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        let updated = try await client.setPinned(true, botId: "avatar-bot")

        XCTAssertEqual(updated.id, "avatar-bot")
        let request = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/avatar-bot/pin")
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["pinned"])
        XCTAssertEqual(body["pinned"] as? Bool, true)
    }

    func testBotPinFallsBackToLegacyPatchOnlyWhenTheNarrowRouteIsMissing() async throws {
        ProfileRequestStub.responseSequence = [
            (404, Data(#"{"error":"no route: PATCH /api/bots/avatar-bot/pin"}"#.utf8)),
            (200, Self.botResponse),
        ]

        let updated = try await client.setPinned(true, botId: "avatar-bot")

        XCTAssertEqual(updated.id, "avatar-bot")
        XCTAssertEqual(
            ProfileRequestStub.capturedRequests.compactMap { $0.url?.path },
            ["/api/bots/avatar-bot/pin", "/api/bots/avatar-bot"]
        )
        XCTAssertEqual(ProfileRequestStub.capturedBodies.count, 2)
        for bodyData in ProfileRequestStub.capturedBodies {
            let data = try XCTUnwrap(bodyData)
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(body.keys.sorted(), ["pinned"])
            XCTAssertEqual(body["pinned"] as? Bool, true)
        }
    }

    func testBotPinDoesNotFallbackForADifferent404() async throws {
        ProfileRequestStub.responseSequence = [
            (404, Data(#"{"error":"no such bot"}"#.utf8)),
        ]

        do {
            _ = try await client.setPinned(true, botId: "avatar-bot")
            XCTFail("pin should preserve a non-route 404")
        } catch let error as APIError {
            guard case let .status(code, message) = error else {
                return XCTFail("unexpected API error: \(error)")
            }
            XCTAssertEqual(code, 404)
            XCTAssertEqual(message, "no such bot")
        }
        XCTAssertEqual(ProfileRequestStub.capturedRequests.count, 1)
    }

    func testBotPinReportsUnsupportedWhenBothPinRoutesAreMissing() async throws {
        ProfileRequestStub.responseSequence = [
            (404, Data(#"{"error":"no route: PATCH /api/bots/avatar-bot/pin"}"#.utf8)),
            (404, Data(#"{"error":"no route: PATCH /api/bots/avatar-bot"}"#.utf8)),
        ]

        let result = try await client.setPinnedResult(true, botId: "avatar-bot")
        guard case .unsupported = result else {
            return XCTFail("both exact missing routes should enable the local fallback")
        }
        XCTAssertEqual(
            ProfileRequestStub.capturedRequests.compactMap { $0.url?.path },
            ["/api/bots/avatar-bot/pin", "/api/bots/avatar-bot"]
        )
    }

    func testBotPinPreservesLegacyNotFoundInsteadOfUsingLocalFallback() async throws {
        ProfileRequestStub.responseSequence = [
            (404, Data(#"{"error":"no route: PATCH /api/bots/avatar-bot/pin"}"#.utf8)),
            (404, Data(#"{"error":"no such bot"}"#.utf8)),
        ]

        do {
            _ = try await client.setPinnedResult(true, botId: "avatar-bot")
            XCTFail("a real legacy 404 must remain an error")
        } catch let error as APIError {
            guard case let .status(code, message) = error else {
                return XCTFail("unexpected API error: \(error)")
            }
            XCTAssertEqual(code, 404)
            XCTAssertEqual(message, "no such bot")
        }
    }

    func testRoomPinClientDecodesTheAuthoritativeRoom() async throws {
        ProfileRequestStub.responseBody = Self.roomResponse

        let updated = try await client.setPinned(true, roomId: "room-1")

        XCTAssertEqual(updated.id, "room-1")
        XCTAssertEqual(updated.pinned, true)
        let request = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/groups/room-1/pin")
    }

    func testRoomPinFallsBackToLegacyPatchWhenTheNarrowRouteIsMissing() async throws {
        ProfileRequestStub.responseSequence = [
            (404, Data(#"{"error":"no route: PATCH /api/groups/room-1/pin"}"#.utf8)),
            (200, Self.roomResponse),
        ]

        let updated = try await client.setPinned(true, roomId: "room-1")

        XCTAssertEqual(updated.id, "room-1")
        XCTAssertEqual(
            ProfileRequestStub.capturedRequests.compactMap { $0.url?.path },
            ["/api/groups/room-1/pin", "/api/groups/room-1"]
        )
        XCTAssertEqual(ProfileRequestStub.capturedBodies.count, 2)
    }

    func testRoomPinDoesNotFallbackForValidationFailure() async throws {
        ProfileRequestStub.responseSequence = [
            (400, Data(#"{"error":"pinned must be true or false"}"#.utf8)),
        ]

        do {
            _ = try await client.setPinned(true, roomId: "room-1")
            XCTFail("pin should preserve a validation failure")
        } catch let error as APIError {
            guard case let .status(code, message) = error else {
                return XCTFail("unexpected API error: \(error)")
            }
            XCTAssertEqual(code, 400)
            XCTAssertEqual(message, "pinned must be true or false")
        }
        XCTAssertEqual(ProfileRequestStub.capturedRequests.count, 1)
    }

    func testAvatarGenerationRequestOutlivesTheServersImageTimeout() async throws {
        ProfileRequestStub.responseBody = Self.generatedAvatarResponse

        _ = try await client.generateAvatar(botId: "avatar-bot", prompt: "Friendly researcher")

        let request = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        XCTAssertGreaterThan(request.timeoutInterval, 120)
    }

    private static let botJSON = """
    {
      "id":"avatar-bot","threadId":"avatar-thread","name":"Scout","title":"Researcher",
      "description":"Finds evidence.","notifications":true,"color":"blue","mascotShape":"hexagon",
      "avatarUrl":"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
      "avatarCrop":"rounded","unread":false,
      "modelSelection":{"instanceId":"local","model":"default"},"createdAt":1786742441013
    }
    """

    private static let botResponseString = "{\"bot\":\(botJSON)}"
    private static let botResponse = Data(botResponseString.utf8)
    private static let botResponseWithPurpleHexagon = Data(
        botResponseString.replacingOccurrences(of: #""color":"blue""#, with: #""color":"purple""#).utf8
    )
    private static let botResponseWithPurpleAndNoShape = Data(
        botResponseString
            .replacingOccurrences(of: #""color":"blue""#, with: #""color":"purple""#)
            .replacingOccurrences(of: ",\"mascotShape\":\"hexagon\"", with: "")
            .utf8
    )
    private static let roomResponse = Data(
        #"{"group":{"id":"room-1","threadId":"room-thread","name":"Research","memberIds":["avatar-bot"],"defaultResponder":{"kind":"member","botId":"avatar-bot"},"bulletin":"","unread":false,"pinned":true,"createdAt":1786742441013}}"#.utf8
    )
    private static let generatedAvatarResponse = Data(
        "{\"avatarUrl\":\"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp\",\"bot\":\(botJSON)}".utf8
    )
}
