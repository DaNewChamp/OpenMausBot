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
        AttachmentRequestStub.statusCode = 201
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
        XCTAssertNoThrow(try AttachmentPath.validate(data: Self.minimalMP4, mime: "video/mp4"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data([1]), mime: "video/mp4"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data([1]), mime: "image/heic"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data(), mime: "image/png"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data(repeating: 0, count: AttachmentPath.maxBytes + 1), mime: "image/png"))
        XCTAssertThrowsError(try AttachmentPath.validate(data: Data(repeating: 0, count: AttachmentPath.maxVideoBytes + 1), mime: "video/mp4"))
    }

    func testAttachmentMIMESniffRejectsMismatches() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        XCTAssertEqual(AttachmentPath.sniffedMIME(data: jpeg, suggested: "video/mp4"), "image/jpeg")
        XCTAssertEqual(AttachmentPath.sniffedMIME(data: jpeg, suggested: "image/png"), "image/jpeg")
        XCTAssertEqual(AttachmentPath.sniffedMIME(data: Self.minimalMP4, suggested: "video/mp4"), "video/mp4")
        XCTAssertEqual(AttachmentPath.sniffedMIME(data: Self.minimalQuickTime, suggested: "video/quicktime"), "video/quicktime")
        XCTAssertNil(AttachmentPath.sniffedMIME(data: Self.minimalMP4, suggested: "video/quicktime"))
        XCTAssertNil(AttachmentPath.sniffedMIME(data: Self.minimalQuickTime, suggested: "video/mp4"))
        XCTAssertNil(AttachmentPath.sniffedMIME(data: Self.minimalMP4, suggested: "image/png"))
        XCTAssertNil(AttachmentPath.sniffedMIME(data: Data([1, 2, 3, 4, 5, 6, 7, 8]), suggested: "video/mp4"))
        XCTAssertEqual(AttachmentPath.sniffedMIME(data: Data([1]), suggested: "image/png"), "image/png")
        XCTAssertThrowsError(try AttachmentPath.validate(data: jpeg, mime: "video/mp4"))
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

    func testUploadVideoUsesALongerBoundedTimeout() async throws {
        AttachmentRequestStub.responseBody = Data(
            #"{"path":"/Users/test/.openmausbot/attachments/abc-123.mp4","mime":"video/mp4","bytes":24}"#.utf8
        )
        _ = try await client.uploadAttachment(data: Self.minimalMP4, mime: "video/mp4")
        let videoRequest = try XCTUnwrap(AttachmentRequestStub.capturedRequest)
        XCTAssertEqual(videoRequest.timeoutInterval, AttachmentPath.videoUploadTimeoutInterval)
        XCTAssertGreaterThan(videoRequest.timeoutInterval, 20)
        XCTAssertLessThanOrEqual(videoRequest.timeoutInterval, 180)

        AttachmentRequestStub.capturedRequest = nil
        AttachmentRequestStub.responseBody = Data(#"{"path":"/Users/test/.openmausbot/attachments/abc-123.png","mime":"image/png","bytes":4}"#.utf8)
        _ = try await client.uploadAttachment(data: Data([1, 2, 3, 4]), mime: "image/png")
        let imageRequest = try XCTUnwrap(AttachmentRequestStub.capturedRequest)
        XCTAssertEqual(imageRequest.timeoutInterval, 20)
    }

    func testOldHarnessVideoErrorsRemapToUpdateComputer() async {
        AttachmentRequestStub.statusCode = 400
        AttachmentRequestStub.responseBody = Data(#"{"error":"content-type must be an image type"}"#.utf8)
        await assertVideoUploadMessage("This computer does not support video attachments yet. Update V Bot on the computer.")

        AttachmentRequestStub.statusCode = 400
        AttachmentRequestStub.responseBody = Data(#"{"error":"unsupported type"}"#.utf8)
        await assertVideoUploadMessage("This computer does not support video attachments yet. Update V Bot on the computer.")

        AttachmentRequestStub.statusCode = 413
        AttachmentRequestStub.responseBody = Data(#"{"error":"attachment exceeds 10485760 bytes"}"#.utf8)
        await assertVideoUploadMessage("This computer does not support video attachments yet. Update V Bot on the computer.")
    }

    func testMissingAttachmentRouteSaysAttachmentsNotImage() async {
        AttachmentRequestStub.statusCode = 404
        AttachmentRequestStub.responseBody = Data(#"{"error":"no route: POST /api/attachments"}"#.utf8)
        await assertVideoUploadMessage("This computer does not support attachments yet. Update V Bot on the computer.")

        do {
            _ = try await client.uploadAttachment(data: Data([1]), mime: "image/png")
            XCTFail("404 should be remapped")
        } catch let error as APIError {
            XCTAssertEqual(
                error.localizedDescription,
                "This computer does not support attachments yet. Update V Bot on the computer."
            )
        } catch {
            XCTFail("unexpected error: \(error)")
        }
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

    private func assertVideoUploadMessage(_ expected: String) async {
        do {
            _ = try await client.uploadAttachment(data: Self.minimalMP4, mime: "video/mp4")
            XCTFail("upload should fail")
        } catch let error as APIError {
            XCTAssertEqual(error.localizedDescription, expected)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    private static let minimalMP4 = Data([
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x61, 0x76, 0x63, 0x31,
    ])

    private static let minimalQuickTime = Data([
        0x00, 0x00, 0x00, 0x14,
        0x66, 0x74, 0x79, 0x70,
        0x71, 0x74, 0x20, 0x20,
        0x00, 0x00, 0x00, 0x00,
        0x71, 0x74, 0x20, 0x20,
    ])

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
