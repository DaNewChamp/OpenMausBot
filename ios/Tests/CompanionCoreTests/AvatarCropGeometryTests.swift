import CoreGraphics
import XCTest
@testable import CompanionCore

final class AvatarCropGeometryTests: XCTestCase {
    private let wide = AvatarCropGeometry.Size(width: 200, height: 100)
    private let tall = AvatarCropGeometry.Size(width: 100, height: 200)
    private let crop = AvatarCropGeometry.Size(width: 100, height: 100)

    func testMinimumScaleIsAspectFillSoTheCropWindowStaysCovered() {
        XCTAssertEqual(AvatarCropGeometry.minimumScale(image: wide, crop: crop), 1, accuracy: 0.000_001)
        XCTAssertEqual(AvatarCropGeometry.minimumScale(image: tall, crop: crop), 1, accuracy: 0.000_001)
        XCTAssertEqual(
            AvatarCropGeometry.minimumScale(
                image: AvatarCropGeometry.Size(width: 4_000, height: 3_000),
                crop: AvatarCropGeometry.Size(width: 280, height: 280)
            ),
            280 / 3_000,
            accuracy: 0.000_001
        )
    }

    func testScaleBelowTheFillMinimumIsRaised() {
        XCTAssertEqual(
            AvatarCropGeometry.clampedScale(0.1, image: wide, crop: crop),
            1,
            accuracy: 0.000_001
        )
        XCTAssertEqual(
            AvatarCropGeometry.clampedScale(2.5, image: wide, crop: crop),
            2.5,
            accuracy: 0.000_001
        )
    }

    func testOffsetIsClampedSoTransparentEdgesCannotEnterTheCrop() {
        let minScale = AvatarCropGeometry.minimumScale(image: wide, crop: crop)
        let centered = AvatarCropGeometry.clampedOffset(.zero, scale: minScale, image: wide, crop: crop)
        XCTAssertEqual(centered.x, 0, accuracy: 0.000_001)
        XCTAssertEqual(centered.y, 0, accuracy: 0.000_001)

        let spilled = AvatarCropGeometry.clampedOffset(
            AvatarCropGeometry.Offset(x: 999, y: -40),
            scale: minScale,
            image: wide,
            crop: crop
        )
        XCTAssertEqual(spilled.x, 50, accuracy: 0.000_001)
        XCTAssertEqual(spilled.y, 0, accuracy: 0.000_001)

        let zoomed = AvatarCropGeometry.clampedOffset(
            AvatarCropGeometry.Offset(x: 400, y: -400),
            scale: 2,
            image: wide,
            crop: crop
        )
        XCTAssertEqual(zoomed.x, 150, accuracy: 0.000_001)
        XCTAssertEqual(zoomed.y, 50, accuracy: 0.000_001)
    }

    func testCenteredSourceRectIsTheCoveringSquareOfTheImage() {
        let scale = AvatarCropGeometry.minimumScale(image: wide, crop: crop)
        let rect = AvatarCropGeometry.sourceRect(image: wide, crop: crop, scale: scale, offset: .zero)
        XCTAssertEqual(rect.origin.x, 50, accuracy: 0.000_001)
        XCTAssertEqual(rect.origin.y, 0, accuracy: 0.000_001)
        XCTAssertEqual(rect.width, 100, accuracy: 0.000_001)
        XCTAssertEqual(rect.height, 100, accuracy: 0.000_001)
        XCTAssertTrue(CGRect(x: 0, y: 0, width: 200, height: 100).contains(rect))
    }

    func testPannedSourceRectStaysInsideTheImage() {
        let scale = AvatarCropGeometry.minimumScale(image: wide, crop: crop)
        let left = AvatarCropGeometry.sourceRect(
            image: wide,
            crop: crop,
            scale: scale,
            offset: AvatarCropGeometry.Offset(x: 50, y: 0)
        )
        XCTAssertEqual(left.origin.x, 0, accuracy: 0.000_001)
        XCTAssertEqual(left.origin.y, 0, accuracy: 0.000_001)
        XCTAssertEqual(left.width, 100, accuracy: 0.000_001)

        let right = AvatarCropGeometry.sourceRect(
            image: wide,
            crop: crop,
            scale: scale,
            offset: AvatarCropGeometry.Offset(x: -50, y: 0)
        )
        XCTAssertEqual(right.origin.x, 100, accuracy: 0.000_001)
        XCTAssertTrue(CGRect(x: 0, y: 0, width: 200, height: 100).contains(right))
    }

    func testResetFitsThePhotoWithoutPan() {
        let transform = AvatarCropGeometry.resetTransform(image: tall, crop: crop)
        XCTAssertEqual(transform.scale, 1, accuracy: 0.000_001)
        XCTAssertEqual(transform.offset, .zero)
    }

    func testOrientedSizeSwapsDimensionsForNinetyDegreeExif() {
        let stored = AvatarCropGeometry.Size(width: 10, height: 20)
        XCTAssertEqual(
            AvatarCropGeometry.orientedSize(pixel: stored, exifOrientation: 1),
            stored
        )
        XCTAssertEqual(
            AvatarCropGeometry.orientedSize(pixel: stored, exifOrientation: 6),
            AvatarCropGeometry.Size(width: 20, height: 10)
        )
        XCTAssertEqual(
            AvatarCropGeometry.orientedSize(pixel: stored, exifOrientation: 8),
            AvatarCropGeometry.Size(width: 20, height: 10)
        )
        XCTAssertEqual(
            AvatarCropGeometry.orientedSize(pixel: stored, exifOrientation: 3),
            stored
        )
    }

    func testOutputPolicyIsABoundedSquareJPEG() {
        XCTAssertEqual(AvatarCropGeometry.outputDimension, 1_024)
        XCTAssertGreaterThan(AvatarCropGeometry.jpegQuality, 0)
        XCTAssertLessThanOrEqual(AvatarCropGeometry.jpegQuality, 1)
        XCTAssertEqual(AvatarCropGeometry.exportMIME, "image/jpeg")
    }
}
