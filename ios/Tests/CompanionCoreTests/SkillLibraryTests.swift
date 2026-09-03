import Foundation
import XCTest
@testable import CompanionCore

private final class SkillLibraryRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var transportError: Error?
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        if let error = Self.transportError {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
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

final class SkillLibraryTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        SkillLibraryRequestStub.responseBody = Data()
        SkillLibraryRequestStub.statusCode = 200
        SkillLibraryRequestStub.transportError = nil
        SkillLibraryRequestStub.capturedRequest = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SkillLibraryRequestStub.self]
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

    func testDecodesSkillsPayloadFieldsFromTheHarnessListing() throws {
        let payload = try JSONDecoder().decode(BotSkillsResponse.self, from: Data(Self.listingJSON.utf8))

        XCTAssertEqual(payload.skills.count, 2)
        XCTAssertEqual(payload.skills[0].name, "code-review")
        XCTAssertEqual(payload.skills[0].description, "Reviews a PR the way this team reviews PRs.")
        XCTAssertEqual(payload.skills[0].enabled, false)
        XCTAssertEqual(payload.skills[0].source, "github.com/x/y/skills/code-review")
        XCTAssertEqual(payload.skills[0].sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(payload.skills[0].importedAt, "2026-09-03T12:00:00.000Z")
        XCTAssertEqual(payload.skills[0].warnings, [])
        XCTAssertEqual(payload.skills[0].skippedFiles, [])
        XCTAssertNil(payload.skills[0].license)

        XCTAssertEqual(payload.skills[1].name, "deploy-helper")
        XCTAssertEqual(payload.skills[1].enabled, true)
        XCTAssertEqual(payload.skills[1].license, "MIT")
        XCTAssertEqual(payload.skills[1].compatibility, "claude-sonnet")
        XCTAssertEqual(payload.skills[1].warnings, [
            "contains a long base64-looking blob — a common wrapper for hidden instructions or payloads",
        ])
        XCTAssertEqual(payload.skills[1].skippedFiles, ["scripts/run.sh"])

        XCTAssertEqual(payload.staged?.count, 1)
        XCTAssertEqual(payload.staged?[0].id, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(payload.staged?[0].action, "create")
        XCTAssertEqual(payload.staged?[0].name, "phone-harness")
        XCTAssertEqual(payload.staged?[0].files?.first?.path, "SKILL.md")
    }

    func testDecodesAnEmptySkillsListing() throws {
        let payload = try JSONDecoder().decode(
            BotSkillsResponse.self,
            from: Data(#"{"skills":[],"staged":[]}"#.utf8)
        )
        XCTAssertTrue(payload.skills.isEmpty)
        XCTAssertEqual(payload.staged?.count, 0)
    }

    func testDecodesASkillWhenOptionalProvenanceFieldsAreOmitted() throws {
        let payload = try JSONDecoder().decode(
            BotSkillsResponse.self,
            from: Data(#"{"skills":[{"name":"tdd"}]}"#.utf8)
        )
        XCTAssertEqual(payload.skills[0].name, "tdd")
        XCTAssertNil(payload.skills[0].description)
        XCTAssertNil(payload.skills[0].enabled)
        XCTAssertNil(payload.staged)
    }

    func testRunPolicyUsesTheHUDNaturalLanguageCommand() {
        let skill = try! JSONDecoder().decode(
            BotSkill.self,
            from: Data(#"{"name":"code-review","description":"Reviews a PR."}"#.utf8)
        )
        XCTAssertEqual(SkillLibraryRunPolicy.command(for: skill), "Use the code-review skill")
        XCTAssertEqual(SkillLibraryRunPolicy.command(name: "tdd"), "Use the tdd skill")
        XCTAssertEqual(SkillLibraryRunPolicy.visibleDescription("  Reviews a PR.  "), "Reviews a PR.")
        XCTAssertNil(SkillLibraryRunPolicy.visibleDescription("   "))
        XCTAssertNil(SkillLibraryRunPolicy.visibleDescription(nil))
    }

    func testClientFetchesBotSkillsOnTheHarnessRoute() async throws {
        SkillLibraryRequestStub.responseBody = Data(Self.listingJSON.utf8)

        let payload = try await client.skills(botId: "bot_123")

        XCTAssertEqual(SkillLibraryRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(SkillLibraryRequestStub.capturedRequest?.url?.path, "/api/bots/bot_123/skills")
        XCTAssertEqual(
            SkillLibraryRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
        XCTAssertEqual(payload.skills.map(\.name), ["code-review", "deploy-helper"])
        XCTAssertEqual(payload.staged?.map(\.name), ["phone-harness"])
    }

    func testClientSurfacesHarnessErrorForAMissingBot() async {
        SkillLibraryRequestStub.statusCode = 404
        SkillLibraryRequestStub.responseBody = Data(#"{"error":"no such bot"}"#.utf8)

        do {
            _ = try await client.skills(botId: "missing")
            XCTFail("expected a status error")
        } catch let APIError.status(code, message) {
            XCTAssertEqual(code, 404)
            XCTAssertEqual(message, "no such bot")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testClientSurfacesUnreadablePayloadAsTransportError() async {
        SkillLibraryRequestStub.responseBody = Data(#"{"skills":"nope"}"#.utf8)

        do {
            _ = try await client.skills(botId: "bot_123")
            XCTFail("expected a transport error")
        } catch let APIError.transport(detail) {
            XCTAssertEqual(detail, "The computer sent something this app couldn't read.")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testClientSurfacesTransportFailure() async {
        SkillLibraryRequestStub.transportError = URLError(.timedOut)

        do {
            _ = try await client.skills(botId: "bot_123")
            XCTFail("expected a transport error")
        } catch let APIError.transport(detail) {
            XCTAssertFalse(detail.isEmpty)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    private static let listingJSON = """
    {
      "skills": [
        {
          "name": "code-review",
          "description": "Reviews a PR the way this team reviews PRs.",
          "enabled": false,
          "source": "github.com/x/y/skills/code-review",
          "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "importedAt": "2026-09-03T12:00:00.000Z",
          "warnings": [],
          "skippedFiles": []
        },
        {
          "name": "deploy-helper",
          "description": "Walks through a production deploy.",
          "enabled": true,
          "source": "src",
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "importedAt": "2026-09-03T12:05:00.000Z",
          "license": "MIT",
          "compatibility": "claude-sonnet",
          "warnings": [
            "contains a long base64-looking blob — a common wrapper for hidden instructions or payloads"
          ],
          "skippedFiles": ["scripts/run.sh"]
        }
      ],
      "staged": [
        {
          "id": "11111111-1111-4111-8111-111111111111",
          "action": "create",
          "name": "phone-harness",
          "gist": "Drive the iPhone from a paired Mac.",
          "source": "learn:phone-harness",
          "files": [
            {
              "path": "SKILL.md",
              "content": "---\\nname: phone-harness\\ndescription: Drive the iPhone from a paired Mac.\\n---\\n\\n# phone-harness\\n"
            }
          ],
          "warnings": [],
          "skippedFiles": [],
          "createdAt": "2026-09-03T12:10:00.000Z"
        }
      ]
    }
    """
}
