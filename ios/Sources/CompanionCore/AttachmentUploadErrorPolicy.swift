import Foundation

/// Maps older harness attachment failures onto copy the phone can stand behind.
/// Newer computers already accept video; a 404 or an image-only 400/413 should
/// not look like a generic transport error or still talk about "image".
public enum AttachmentUploadErrorPolicy {
    public static let videoUnsupportedMessage =
        "This computer does not support video attachments yet. Update V Bot on the computer."
    public static let attachmentsUnsupportedMessage =
        "This computer does not support attachments yet. Update V Bot on the computer."

    public static func remap(_ error: APIError, mime: String) -> APIError {
        let video = AttachmentPath.normalizedMIME(mime)?.hasPrefix("video/") == true
        switch error {
        case let .status(code, message):
            if code == 404 {
                return .transport(attachmentsUnsupportedMessage)
            }
            if video, code == 413 {
                return .transport(videoUnsupportedMessage)
            }
            if video, code == 400, isImageOnlyOrUnsupportedType(message) {
                return .transport(videoUnsupportedMessage)
            }
            return error
        default:
            return error
        }
    }

    private static func isImageOnlyOrUnsupportedType(_ message: String?) -> Bool {
        guard let message else { return false }
        let lower = message.lowercased()
        if lower.contains("unsupported type") { return true }
        if lower.contains("must be an image") { return true }
        if lower.contains("image type") { return true }
        if lower.contains("image-only") || lower.contains("image only") { return true }
        return false
    }
}
