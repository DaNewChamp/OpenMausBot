import XCTest
@testable import CompanionCore

final class AvatarPhotoPresentationTests: XCTestCase {
    func testAccountPhotoActionsAndEditorLabels() {
        XCTAssertEqual(AvatarPhotoPresentation.photoActionTitle(hasPhoto: false), "Upload photo")
        XCTAssertEqual(AvatarPhotoPresentation.photoActionTitle(hasPhoto: true), "Change photo")
        XCTAssertEqual(AvatarPhotoPresentation.removePhotoTitle, "Remove photo")
        XCTAssertEqual(AvatarPhotoPresentation.editorTitle, "Crop photo")
        XCTAssertEqual(AvatarPhotoPresentation.usePhotoTitle, "Use Photo")
        XCTAssertEqual(AvatarPhotoPresentation.cancelTitle, "Cancel")
        XCTAssertEqual(AvatarPhotoPresentation.resetTitle, "Reset")
        XCTAssertEqual(AvatarPhotoPresentation.uploadingLabel, "Uploading photo")
    }

    func testVoiceOverHintsDescribeCropAndCancellation() {
        XCTAssertEqual(
            AvatarPhotoPresentation.cropCanvasHint,
            "Pinch to zoom. Drag to reposition."
        )
        XCTAssertEqual(
            AvatarPhotoPresentation.usePhotoHint,
            "Saves the cropped photo"
        )
        XCTAssertEqual(
            AvatarPhotoPresentation.cancelHint,
            "Discards this crop"
        )
        XCTAssertEqual(
            AvatarPhotoPresentation.resetHint,
            "Fits the photo in the crop window"
        )
        XCTAssertEqual(
            AvatarPhotoPresentation.uploadPhotoHint,
            "Choose a photo, then crop it before saving"
        )
        XCTAssertEqual(
            AvatarPhotoPresentation.removePhotoHint,
            "Removes the photo and uses your icon"
        )
    }

    func testOwnerCopyIsLocalToThisIPhoneAndDoesNotClaimSync() {
        let copy = AvatarPhotoPresentation.ownerLocalCopy
        XCTAssertTrue(copy.localizedCaseInsensitiveContains("this iPhone"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("iCloud"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("sync"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("computer"))
        XCTAssertEqual(
            copy,
            "This photo stays on this iPhone."
        )
    }

    func testCancelNeverPersistsAndUsePhotoDoes() {
        XCTAssertFalse(AvatarPhotoPresentation.shouldPersist(confirmed: false))
        XCTAssertTrue(AvatarPhotoPresentation.shouldPersist(confirmed: true))
        let snapshot = AvatarPhotoPresentation.Snapshot(revision: 4, photoPresent: true)
        XCTAssertEqual(AvatarPhotoPresentation.afterCancel(snapshot), snapshot)
    }

    func testAnimatedFormatsAreRejectedWithoutClaimingPreservation() {
        let message = AvatarPhotoPresentation.animatedRejectionMessage
        XCTAssertTrue(message.localizedCaseInsensitiveContains("animated"))
        XCTAssertFalse(message.localizedCaseInsensitiveContains("preserved"))
        XCTAssertFalse(message.localizedCaseInsensitiveContains("keep the animation"))
        XCTAssertEqual(
            message,
            "Animated GIF and WebP cannot be cropped. Choose a still photo."
        )
        XCTAssertFalse(AvatarPhotoPresentation.canEdit(isAnimated: true))
        XCTAssertTrue(AvatarPhotoPresentation.canEdit(isAnimated: false))
    }

    func testBotUploadKeepsTheExistingTenMegabyteCeilingAndJPEGExport() {
        XCTAssertEqual(AvatarPhotoPresentation.botUploadLimitBytes, AttachmentPath.maxBytes)
        XCTAssertEqual(AvatarPhotoPresentation.botUploadLimitBytes, 10 * 1_024 * 1_024)
        XCTAssertEqual(AvatarPhotoPresentation.exportMIME, "image/jpeg")
        XCTAssertFalse(AvatarPhotoPresentation.shouldUploadOnCancel)
    }
}
