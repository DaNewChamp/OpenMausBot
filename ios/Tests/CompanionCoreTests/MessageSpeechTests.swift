import Foundation
import XCTest
@testable import CompanionCore

private final class MessageSpeechStub: URLProtocol {
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
            url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
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

final class MessageSpeechTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        MessageSpeechStub.responseBody = Data()
        MessageSpeechStub.statusCode = 200
        MessageSpeechStub.capturedRequest = nil
        MessageSpeechStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MessageSpeechStub.self]
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

    private func capturedBodyDictionary() throws -> [String: Any] {
        let data = try XCTUnwrap(MessageSpeechStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testPrepareSpeechPostsMessageTextAndVoice() async throws {
        MessageSpeechStub.responseBody = Data(
            #"{"ready":true,"utterances":["Hello there.","One more line."]}"#.utf8
        )

        let preparation = try await client.prepareSpeech(text: "Hello there. One more line.", voiceId: "voice-9")

        XCTAssertTrue(preparation.ready == true)
        XCTAssertEqual(preparation.utterances, ["Hello there.", "One more line."])
        XCTAssertEqual(MessageSpeechStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(MessageSpeechStub.capturedRequest?.url?.path, "/api/tts/prepare")
        XCTAssertEqual(
            MessageSpeechStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
        let body = try capturedBodyDictionary()
        XCTAssertEqual(body["text"] as? String, "Hello there. One more line.")
        XCTAssertEqual(body["voiceId"] as? String, "voice-9")
    }

    func testPrepareSpeechOmitsVoiceSoWorkspaceDefaultApplies() async throws {
        MessageSpeechStub.responseBody = Data(#"{"ready":false}"#.utf8)

        let preparation = try await client.prepareSpeech(text: "Hello", voiceId: "   ")

        XCTAssertTrue(preparation.ready == false)
        let body = try capturedBodyDictionary()
        XCTAssertEqual(body["text"] as? String, "Hello")
        XCTAssertNil(body["voiceId"])
    }

    func testSpeakPostsUtteranceAndReturnsAudioBytes() async throws {
        let audio = Data([0xFF, 0xF3, 0x40, 0x00, 0x11])
        MessageSpeechStub.responseBody = audio

        let returned = try await client.speak(text: "Hello there.", voiceId: "voice-9")

        XCTAssertEqual(returned, audio)
        XCTAssertEqual(MessageSpeechStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(MessageSpeechStub.capturedRequest?.url?.path, "/api/tts/speak")
        let body = try capturedBodyDictionary()
        XCTAssertEqual(body["text"] as? String, "Hello there.")
        XCTAssertEqual(body["voiceId"] as? String, "voice-9")
    }

    func testSpeakSurfacesHarnessErrorMessage() async throws {
        MessageSpeechStub.statusCode = 413
        MessageSpeechStub.responseBody = Data(
            #"{"error":"voice utterances are limited to 500 characters"}"#.utf8
        )

        do {
            _ = try await client.speak(text: String(repeating: "x", count: 501), voiceId: nil)
            XCTFail("Expected the harness's error to surface.")
        } catch let error as APIError {
            guard case let .status(code, message) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(code, 413)
            XCTAssertEqual(message, "voice utterances are limited to 500 characters")
        }
    }

    func testPlanFollowsPreparedUtterances() {
        let plan = MessageSpeechPolicy.plan(
            preparation: TtsPreparation(ready: true, utterances: ["a", "b"]),
            text: "ignored"
        )
        XCTAssertEqual(plan, .speak(utterances: ["a", "b"]))
    }

    func testPlanRefusesWhenHarnessSaysNotReady() {
        let plan = MessageSpeechPolicy.plan(
            preparation: TtsPreparation(ready: false, utterances: ["a"]),
            text: "Hello"
        )
        XCTAssertEqual(plan, .notReady)
        XCTAssertFalse(MessageSpeechPolicy.notReadyMessage.isEmpty)
    }

    func testPlanFallsBackToWholeTextWhenNothingWasSplit() {
        let plan = MessageSpeechPolicy.plan(
            preparation: TtsPreparation(ready: true, utterances: []),
            text: "  Hello there.  "
        )
        XCTAssertEqual(plan, .speak(utterances: ["Hello there."]))
    }

    func testPlanHasNothingToSayForEmptyText() {
        let plan = MessageSpeechPolicy.plan(
            preparation: TtsPreparation(ready: true, utterances: nil),
            text: "   "
        )
        XCTAssertEqual(plan, .speak(utterances: []))
    }
}
