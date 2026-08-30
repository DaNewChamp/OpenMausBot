import Foundation
import XCTest
@testable import CompanionCore

private final class AttachmentRequestStub: URLProtocol {
    static var responseBody = Data(#"{"path":"/Users/test/.openmausbot/attachments/abc-123.png","mime":"image/png","bytes":4}"#.utf8)
    static var responseBytes = Data([0x89, 0x50, 0x4E, 0x47])
    static var statusCode = 201
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        let isImage = request.httpMethod == "GET"
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: isImage ? 200 : Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": isImage ? "image/png" : "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: isImage ? Self.responseBytes : Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class AttachmentTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        AttachmentRequestStub.responseBody = Data(#"{"path":"/Users/test/.openmausbot/attachments/abc-123.png","mime":"image/png","bytes":4}"#.utf8)
        AttachmentRequestStub.capturedRequest = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AttachmentRequestStub.self]
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

    func testAttachmentPathAcceptsOnlyAbsoluteGeneratedNames() {
        let absolute = "/Users/test/.openmausbot/attachments/abc-123.webp"
        XCTAssertEqual(AttachmentPath.servingPath(from: absolute), "/api/attachments/abc-123.webp")
        XCTAssertEqual(AttachmentPath.servingPath(from: "C:\\data\\attachments\\abc-123.jpg"), "/api/attachments/abc-123.jpg")
        XCTAssertNil(AttachmentPath.servingPath(from: "attachments/abc-123.png"))
        XCTAssertNil(AttachmentPath.servingPath(from: "/Users/test/attachments/../secret.png"))
        XCTAssertNil(AttachmentPath.servingPath(from: "/Users/test/attachments/abc_123.png"))
        XCTAssertNil(AttachmentPath.servingPath(from: "/Users/test/attachments/abc-123.svg"))
    }

    func testAttachmentPromptComposesAndStripsSafeImageTags() {
        let path = "/Users/test/.openmausbot/attachments/abc-123.png"
        let prompt = AttachmentPrompt.compose(text: "  what is this?  ", paths: [path, "/tmp/elsewhere.png"])
        XCTAssertEqual(prompt, "what is this?\n\n<attached-image path=\"/Users/test/.openmausbot/attachments/abc-123.png\" />")

        let parsed = AttachmentPrompt.split(prompt)
        XCTAssertEqual(parsed.display, "what is this?")
        XCTAssertEqual(parsed.paths, [path])
    }

    func testAttachmentValidationHonorsMimeAndSizeCeilings() {
        XCTAssertNoThrow(try AttachmentPath.validate(data: Data([1]), mime: "image/png; charset=binary"))
        XCTAssertNoThrow(try AttachmentPath.validate(data: Data([1]), mime: "video/mp4"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data([1]), mime: "image/heic"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data(), mime: "image/png"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data(repeating: 0, count: AttachmentPath.maxBytes + 1), mime: "image/png"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data(repeating: 0, count: AttachmentPath.maxVideoBytes + 1), mime: "video/mp4"))
    }

    func testAttachmentPromptUsesFileTagForVideoPaths() {
        let path = "/Users/test/.openmausbot/attachments/abc-123.mp4"
        let prompt = AttachmentPrompt.compose(
            text: "look",
            attachments: [AttachmentPrompt.Item(path: path, mime: "video/mp4")]
        )
        XCTAssertEqual(prompt, "look\n\n<attached-file path=\"/Users/test/.openmausbot/attachments/abc-123.mp4\" />")
        let parsed = AttachmentPrompt.splitAll(prompt)
        XCTAssertEqual(parsed.filePaths, [path])
        XCTAssertTrue(parsed.imagePaths.isEmpty)
    }

    func testUploadAttachmentUsesRawImageBytesAndReturnsServerPath() async throws {
        let uploaded = try await client.uploadAttachment(data: Data([1, 2, 3, 4]), mime: "image/png")

        XCTAssertEqual(uploaded.path, "/Users/test/.openmausbot/attachments/abc-123.png")
        XCTAssertEqual(uploaded.mime, "image/png")
        XCTAssertEqual(uploaded.bytes, 4)
        let request = try XCTUnwrap(AttachmentRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/attachments")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "image/png")
        XCTAssertEqual(Self.body(from: request), Data([1, 2, 3, 4]))
    }

    func testUploadAttachmentRejectsUnsafeServerPathBeforeItCanBeUsed() async {
        AttachmentRequestStub.responseBody = Data(#"{"path":"/Users/test/.openmausbot/attachments/../secret.png","mime":"image/png","bytes":4}"#.utf8)

        do {
            _ = try await client.uploadAttachment(data: Data([1]), mime: "image/png")
            XCTFail("unsafe attachment path should be rejected")
        } catch let error as APIError {
            XCTAssertEqual(error.localizedDescription, "The uploaded attachment could not be used.")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testAttachmentFetchUsesTheSameOriginGeneratedRoute() async throws {
        let data = try await client.attachment(path: "/Users/test/.openmausbot/attachments/abc-123.png")

        XCTAssertEqual(data, AttachmentRequestStub.responseBytes)
        let request = try XCTUnwrap(AttachmentRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/attachments/abc-123.png")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
    }

    private static func body(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
