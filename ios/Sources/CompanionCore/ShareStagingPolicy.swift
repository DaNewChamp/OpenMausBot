import Foundation

/// Share-sheet payload waiting for the next `ChatView` to absorb. Consume can
/// finish on the home list before a chat exists, so absorption has to be a
/// take-once move rather than an `onChange`-only copy.
public struct ShareStaging: Equatable, Sendable {
    public var text: String?
    public var imageData: Data?

    public init(text: String? = nil, imageData: Data? = nil) {
        self.text = text
        self.imageData = imageData
    }

    public var isEmpty: Bool { text == nil && imageData == nil }

    /// Move the current payload out so a second absorb is a no-op.
    @discardableResult
    public mutating func take() -> ShareStaging {
        let payload = self
        self = ShareStaging()
        return payload
    }

    public mutating func discard() {
        self = ShareStaging()
    }
}

public enum ShareStagingPolicy {
    /// Same merge the composer uses when a chat already has a draft.
    public static func merging(_ staged: String, into draft: String) -> String {
        let text = staged.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return draft }
        if draft.isEmpty { return text }
        if draft.hasSuffix(" ") { return draft + text }
        return draft + " " + text
    }

    /// Share-sheet bytes are often PNG/HEIC/JPEG with a `.jpg` inbox name or
    /// a generic UTI. Only sniffed still-image types enter the composer.
    public static func acceptedSharedImageMIME(for data: Data) -> String? {
        guard let mime = AttachmentPath.sniffedMIME(data: data, suggested: "application/octet-stream"),
              mime.hasPrefix("image/")
        else { return nil }
        return mime
    }

    public static func acceptedShareImageData(_ data: Data) -> Data? {
        acceptedSharedImageMIME(for: data) == nil ? nil : data
    }
}
