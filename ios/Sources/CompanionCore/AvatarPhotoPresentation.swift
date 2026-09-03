import Foundation

/// Shared owner/bot avatar crop copy, VoiceOver strings, and persist rules.
public enum AvatarPhotoPresentation: Sendable {
    public static let uploadPhotoTitle = "Upload photo"
    public static let changePhotoTitle = "Change photo"
    public static let removePhotoTitle = "Remove photo"
    public static let editorTitle = "Crop photo"
    public static let usePhotoTitle = "Use Photo"
    public static let cancelTitle = "Cancel"
    public static let resetTitle = "Reset"
    public static let uploadingLabel = "Uploading photo"
    public static let cropCanvasHint = "Pinch to zoom. Drag to reposition."
    public static let usePhotoHint = "Saves the cropped photo"
    public static let cancelHint = "Discards this crop"
    public static let resetHint = "Fits the photo in the crop window"
    public static let uploadPhotoHint = "Choose a photo, then crop it before saving"
    public static let removePhotoHint = "Removes the photo and uses your icon"
    public static let ownerLocalCopy = "This photo stays on this iPhone."
    public static let animatedRejectionMessage =
        "Animated GIF and WebP cannot be cropped. Choose a still photo."
    public static let exportMIME = AvatarCropGeometry.exportMIME
    public static let botUploadLimitBytes = AttachmentPath.maxBytes
    public static let shouldUploadOnCancel = false

    public struct Snapshot: Equatable, Sendable {
        public var revision: Int
        public var photoPresent: Bool

        public init(revision: Int, photoPresent: Bool) {
            self.revision = revision
            self.photoPresent = photoPresent
        }
    }

    public static func photoActionTitle(hasPhoto: Bool) -> String {
        hasPhoto ? changePhotoTitle : uploadPhotoTitle
    }

    public static func shouldPersist(confirmed: Bool) -> Bool {
        confirmed
    }

    public static func afterCancel(_ snapshot: Snapshot) -> Snapshot {
        snapshot
    }

    public static func canEdit(isAnimated: Bool) -> Bool {
        !isAnimated
    }
}
