import Foundation
import XCTest
@testable import CompanionCore

private final class HermesSetupRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
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

final class HermesSetupTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        HermesSetupRequestStub.responseBody = Data()
        HermesSetupRequestStub.statusCode = 200
        HermesSetupRequestStub.capturedRequest = nil
        HermesSetupRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HermesSetupRequestStub.self]
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

    func testDecodesEndpointAuthStatusAndSignInWithoutSecrets() throws {
        let data = Data(
            #"{"state":"unavailable","reason":"invalid_credentials","profiles":[{"profile":"default","handle":"hermes","displayName":"Hermes","description":"Local assistant","canonicalChat":"absent","availability":"unavailable","placement":{"kind":"local","profile":"default"},"endpoint":{"id":"local:hub:default","kind":"local","profile":"default","computerName":"Studio","label":"Studio · Hermes"},"authStatus":"signInRequired","signIn":{"available":true}}],"capabilities":{"roster":true,"canonicalChat":false,"send":false,"finalResponse":false,"events":false,"stop":false,"routinesRead":false,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":false,"steer":false,"attachments":false}}"#.utf8
        )

        let status = try JSONDecoder().decode(HermesSetupStatus.self, from: data)
        let profile = status.profiles.first

        XCTAssertEqual(profile?.authStatus, .signInRequired)
        XCTAssertEqual(profile?.endpoint?.computerName, "Studio")
        XCTAssertEqual(profile?.endpoint?.label, "Studio · Hermes")
        XCTAssertEqual(profile?.signIn?.available, true)
        XCTAssertEqual(HermesSetupPresentationPolicy.authStatusLabel(.connected), "Connected")
        XCTAssertEqual(HermesSetupPresentationPolicy.authStatusLabel(.signInRequired), "Sign-in required")
        XCTAssertEqual(HermesSetupPresentationPolicy.authStatusLabel(.offline), "Offline")
        XCTAssertEqual(HermesSetupPresentationPolicy.authStatusLabel(.unavailable), "Unavailable")
        XCTAssertFalse(String(data: data, encoding: .utf8)!.contains("sk-"))
        XCTAssertFalse(String(data: data, encoding: .utf8)!.contains("HERMES_HOME"))
    }

    func testConnectEncodesBotRebindAndSignInPlacement() async throws {
        HermesSetupRequestStub.responseBody = Data(
            #"{"botId":"bot-keep","profile":{"profile":"work","handle":"work","displayName":"Work","description":"Work","canonicalChat":"absent","availability":"available","placement":{"kind":"local","profile":"work"},"botId":"bot-keep"},"status":{"state":"connected","profiles":[],"capabilities":{"roster":true,"canonicalChat":false,"send":true,"finalResponse":true,"events":true,"stop":true,"routinesRead":false,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":false,"steer":false,"attachments":false}},"created":false}"#.utf8
        )

        _ = try await client.connectHermes(
            botId: "bot-keep",
            placement: HermesSetupPlacement(kind: .local, profile: "work")
        )
        struct RebindBody: Decodable {
            let botId: String
            let placement: HermesSetupPlacement
        }
        let rebind = try JSONDecoder().decode(
            RebindBody.self,
            from: HermesSetupRequestStub.capturedBody ?? Data()
        )
        XCTAssertEqual(rebind.botId, "bot-keep")
        XCTAssertEqual(rebind.placement.profile, "work")

        HermesSetupRequestStub.responseBody = Data(
            #"{"kind":"terminal","computerName":"Mac mini","message":"Complete sign-in on Mac mini, then try again."}"#.utf8
        )
        let handoff = try await client.startHermesSignIn(
            placement: HermesSetupPlacement(kind: .bridge, profile: "default", bridge: "Mac mini")
        )
        XCTAssertEqual(HermesSetupRequestStub.capturedRequest?.url?.path, "/api/hermes/setup/signin")
        XCTAssertEqual(handoff.computerName, "Mac mini")
        XCTAssertEqual(handoff.message, "Complete sign-in on Mac mini, then try again.")
        XCTAssertFalse(handoff.message.contains("—"))
    }

    func testDecodesHermesSetupStatusAndUnknownValuesSafely() throws {
        let data = Data(
            #"{"state":"connected","reason":"future_reason","profiles":[{"profile":"default","handle":"hermes","displayName":"Hermes","description":"Primary profile","canonicalChat":"present","availability":"available","botId":"bot-1","future":"ignored"}],"capabilities":{"roster":true,"canonicalChat":true,"send":true,"finalResponse":true,"events":true,"stop":true,"routinesRead":true,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":true,"steer":true,"attachments":false}}"#.utf8
        )

        let status = try JSONDecoder().decode(HermesSetupStatus.self, from: data)

        XCTAssertEqual(status.state, .connected)
        XCTAssertEqual(status.reason, .unknown)
        XCTAssertEqual(status.profiles.first?.profile, "default")
        XCTAssertEqual(status.profiles.first?.botId, "bot-1")
        XCTAssertTrue(status.capabilities.canonicalChat)
    }

    func testDecodesBridgePlacementProfilesSafely() throws {
        let data = Data(
            #"{"state":"ready","profiles":[{"profile":"default","handle":"hermes","displayName":"Hermes","description":"Remote assistant","canonicalChat":"absent","availability":"available","placement":{"kind":"bridge","bridge":"Mac mini","profile":"default"}}],"capabilities":{"roster":true,"canonicalChat":false,"send":false,"finalResponse":false,"events":false,"stop":false,"routinesRead":false,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":false,"steer":false,"attachments":false}}"#.utf8
        )

        let status = try JSONDecoder().decode(HermesSetupStatus.self, from: data)
        let profile = status.profiles.first

        XCTAssertEqual(profile?.placement?.kind, .bridge)
        XCTAssertEqual(profile?.placement?.bridge, "Mac mini")
        XCTAssertEqual(profile?.id, "bridge:mac mini:default")
        XCTAssertFalse(String(data: data, encoding: .utf8)!.contains("bridgeId"))
    }

    func testConnectEncodesTypedBridgePlacement() async throws {
        HermesSetupRequestStub.responseBody = Data(
            #"{"botId":"bot-1","profile":{"profile":"default","handle":"hermes","displayName":"Hermes","description":"Remote","canonicalChat":"absent","availability":"available","placement":{"kind":"bridge","bridge":"mini","profile":"default"},"botId":"bot-1"},"status":{"state":"connected","profiles":[],"capabilities":{"roster":true,"canonicalChat":false,"send":true,"finalResponse":true,"events":true,"stop":true,"routinesRead":false,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":false,"steer":false,"attachments":false}},"created":true}"#.utf8
        )

        _ = try await client.connectHermes(
            placement: HermesSetupPlacement(kind: .bridge, profile: "default", bridge: "mini")
        )
        struct ConnectBody: Decodable { let placement: HermesSetupPlacement }
        let body = try JSONDecoder().decode(
            ConnectBody.self,
            from: HermesSetupRequestStub.capturedBody ?? Data()
        )
        XCTAssertEqual(body.placement.kind, .bridge)
        XCTAssertEqual(body.placement.profile, "default")
        XCTAssertEqual(body.placement.bridge, "mini")
    }

    func testPlacementLabelsAndGroupingUseFriendlyBridgeNames() {
        let status = HermesSetupStatus(profiles: [
            profile("default", handle: "hermes"),
            HermesSetupProfile(
                profile: "default",
                handle: "hermes",
                displayName: "Hermes",
                description: "Remote",
                canonicalChat: .absent,
                availability: .available,
                placement: HermesSetupPlacement(kind: .bridge, profile: "default", bridge: "Mac mini")
            ),
            HermesSetupProfile(
                profile: "work",
                handle: "work",
                displayName: "Work",
                description: "Remote work",
                canonicalChat: .absent,
                availability: .available,
                placement: HermesSetupPlacement(kind: .bridge, profile: "work", bridge: "office mac")
            ),
        ])

        XCTAssertEqual(
            HermesSetupPresentationPolicy.placementLabel(
                placement: HermesSetupPlacement(kind: .local, profile: "default"),
                computerName: "MacBook Pro"
            ),
            "MacBook Pro"
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.placementLabel(
                placement: HermesSetupPlacement(kind: .bridge, profile: "default", bridge: "Mac mini")
            ),
            "Mac mini"
        )
        XCTAssertTrue(HermesSetupPresentationPolicy.hasRemotePlacements(status))

        let groups = HermesSetupPresentationPolicy.profilesGroupedByPlacement(status, computerName: "Hub")
        XCTAssertEqual(groups.map(\.label), ["Hub", "Mac mini", "office mac"])
        XCTAssertEqual(groups[1].profiles.map(\.profile), ["default"])
        XCTAssertEqual(groups[2].profiles.map(\.profile), ["work"])
    }

    func testDistinctIdsForSameProfileOnDifferentPlacements() {
        let local = profile("default", handle: "hermes")
        let remote = HermesSetupProfile(
            profile: "default",
            handle: "hermes",
            displayName: "Hermes",
            description: "Remote",
            canonicalChat: .absent,
            availability: .available,
            placement: HermesSetupPlacement(kind: .bridge, profile: "default", bridge: "mini")
        )
        XCTAssertNotEqual(local.id, remote.id)
    }

    func testReadsStatusThroughAuthenticatedHermesRoute() async throws {
        HermesSetupRequestStub.responseBody = Data(
            #"{"state":"ready","profiles":[],"capabilities":{"roster":true,"canonicalChat":false,"send":false,"finalResponse":false,"events":false,"stop":false,"routinesRead":false,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":false,"steer":false,"attachments":false}}"#.utf8
        )

        let status = try await client.hermesSetupStatus()

        XCTAssertEqual(HermesSetupRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(HermesSetupRequestStub.capturedRequest?.url?.path, "/api/hermes/setup/status")
        XCTAssertEqual(
            HermesSetupRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
        XCTAssertEqual(status.state, .ready)
    }

    func testConnectOmitsProfileForDefaultAndEncodesExplicitProfile() async throws {
        HermesSetupRequestStub.responseBody = Data(
            #"{"botId":"bot-1","profile":{"profile":"default","handle":"hermes","displayName":"Hermes","description":"Primary profile","canonicalChat":"present","availability":"available","botId":"bot-1"},"status":{"state":"connected","profiles":[],"capabilities":{"roster":true,"canonicalChat":true,"send":true,"finalResponse":true,"events":true,"stop":true,"routinesRead":true,"messageAgent":false,"groups":false,"crossMachine":false,"queueing":false,"steer":false,"attachments":false}},"created":true}"#.utf8
        )

        _ = try await client.connectHermes()
        XCTAssertEqual(HermesSetupRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(HermesSetupRequestStub.capturedRequest?.url?.path, "/api/hermes/setup")
        XCTAssertEqual(String(data: HermesSetupRequestStub.capturedBody ?? Data(), encoding: .utf8), "{}")

        _ = try await client.connectHermes(profile: "team")
        XCTAssertEqual(
            String(data: HermesSetupRequestStub.capturedBody ?? Data(), encoding: .utf8),
            #"{"profile":"team"}"#
        )
    }

    func testPresentationMapsServerStatesToPlainLanguage() {
        XCTAssertEqual(
            HermesSetupPresentationPolicy.presentation(status: nil, isLoading: true).state,
            .checking
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.presentation(
                status: HermesSetupStatus(state: .disabled),
                isLoading: false
            ).state,
            .ready
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.presentation(
                status: HermesSetupStatus(state: .unavailable, reason: .missingCLI),
                isLoading: false
            ).state,
            .needsSetup
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.presentation(
                status: HermesSetupStatus(state: .unavailable, reason: .gatewayUnavailable),
                isLoading: false
            ).state,
            .unavailable
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.presentation(
                status: HermesSetupStatus(state: .connected),
                isLoading: false
            ).title,
            "Hermes connected"
        )
    }

    func testProfileChoiceOnlyAppearsForMultipleAvailableProfiles() {
        let one = HermesSetupStatus(profiles: [profile("default", handle: "hermes")])
        XCTAssertFalse(HermesSetupPresentationPolicy.requiresProfileChoice(one))
        XCTAssertFalse(HermesSetupPresentationPolicy.shouldShowProfileList(one))
        XCTAssertEqual(HermesSetupPresentationPolicy.defaultProfile(one)?.profile, "default")

        let many = HermesSetupStatus(profiles: [
            profile("default", handle: "hermes"),
            profile("work", handle: "work"),
            HermesSetupProfile(
                profile: "offline",
                handle: "offline",
                displayName: "Offline",
                description: "Unavailable",
                model: nil,
                provider: nil,
                canonicalChat: .unknown,
                availability: .unavailable,
                botId: nil
            ),
        ])
        XCTAssertTrue(HermesSetupPresentationPolicy.requiresProfileChoice(many))
        XCTAssertTrue(HermesSetupPresentationPolicy.shouldShowProfileList(many))
        XCTAssertEqual(HermesSetupPresentationPolicy.defaultProfile(many)?.profile, "default")
        XCTAssertEqual(HermesSetupPresentationPolicy.availableProfiles(many).map(\.profile), ["default", "work"])
    }

    func testConnectedProfileUsesOpenChatActionWithoutSetup() {
        XCTAssertEqual(
            HermesSetupPresentationPolicy.profileAction(profile("default", handle: "hermes")),
            .connect
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.profileAction(
                HermesSetupProfile(
                    profile: "default",
                    handle: "hermes",
                    displayName: "Hermes",
                    description: "Profile",
                    availability: .available,
                    botId: "bot-1"
                )
            ),
            .openChat
        )
        XCTAssertEqual(
            HermesSetupPresentationPolicy.profileAction(
                HermesSetupProfile(
                    profile: "default",
                    handle: "hermes",
                    displayName: "Hermes",
                    description: "Profile",
                    availability: .unavailable,
                    authStatus: .signInRequired,
                    signIn: HermesSignInAvailability(available: true)
                )
            ),
            .signIn
        )
        XCTAssertTrue(HermesSetupPresentationPolicy.isHermesBoundBot(title: "Hermes Bot Chat", instanceId: "hermes"))
        XCTAssertFalse(HermesSetupPresentationPolicy.isHermesBoundBot(title: "Scout", instanceId: "claude"))
    }

    private func profile(_ id: String, handle: String) -> HermesSetupProfile {
        HermesSetupProfile(
            profile: id,
            handle: handle,
            displayName: handle.capitalized,
            description: "Profile",
            model: nil,
            provider: nil,
            canonicalChat: .unknown,
            availability: .available,
            botId: nil
        )
    }
}
