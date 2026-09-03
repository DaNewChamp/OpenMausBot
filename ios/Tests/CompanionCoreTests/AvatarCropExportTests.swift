import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CompanionCore

final class AvatarCropExportTests: XCTestCase {
    func testExportIsADeterministicSquareJPEGAtTheBoundedDimension() throws {
        let jpeg = try AvatarImageFixtures.horizontalSplitJPEG(width: 40, height: 20)
        let inspection = try XCTUnwrap(AvatarCropExport.inspect(jpeg))
        XCTAssertEqual(inspection.pixelSize.width, 40)
        XCTAssertEqual(inspection.pixelSize.height, 20)
        XCTAssertFalse(inspection.isAnimated)
        XCTAssertTrue(AvatarPhotoPresentation.canEdit(isAnimated: inspection.isAnimated))

        let crop = AvatarCropGeometry.Size(width: 20, height: 20)
        let scale = AvatarCropGeometry.minimumScale(image: inspection.pixelSize, crop: crop)
        let exported = try AvatarCropExport.exportJPEG(
            data: jpeg,
            crop: crop,
            scale: scale,
            offset: .zero
        )
        XCTAssertTrue(AvatarCropExport.isJPEG(exported))
        let output = try XCTUnwrap(AvatarCropExport.inspect(exported))
        XCTAssertEqual(output.pixelSize.width, Double(AvatarCropGeometry.outputDimension))
        XCTAssertEqual(output.pixelSize.height, Double(AvatarCropGeometry.outputDimension))
        XCTAssertLessThanOrEqual(exported.count, AvatarPhotoPresentation.botUploadLimitBytes)
        XCTAssertFalse(output.isAnimated)
    }

    func testLeftPanCropStaysOnTheRedHalf() throws {
        let jpeg = try AvatarImageFixtures.horizontalSplitJPEG(width: 40, height: 20)
        let inspection = try XCTUnwrap(AvatarCropExport.inspect(jpeg))
        let crop = AvatarCropGeometry.Size(width: 20, height: 20)
        let scale = AvatarCropGeometry.minimumScale(image: inspection.pixelSize, crop: crop)
        let exported = try AvatarCropExport.exportJPEG(
            data: jpeg,
            crop: crop,
            scale: scale,
            offset: AvatarCropGeometry.Offset(x: 10, y: 0)
        )
        let sample = try AvatarImageFixtures.centerPixel(of: exported)
        XCTAssertGreaterThan(sample.red, 200)
        XCTAssertLessThan(sample.blue, 40)
    }

    func testExifOrientationSixUsesTheUprightPixelSize() throws {
        let jpeg = try AvatarImageFixtures.orientationSixJPEG(width: 10, height: 20)
        let inspection = try XCTUnwrap(AvatarCropExport.inspect(jpeg))
        XCTAssertEqual(inspection.pixelSize.width, 20)
        XCTAssertEqual(inspection.pixelSize.height, 10)
        XCTAssertEqual(inspection.exifOrientation, 6)

        let crop = AvatarCropGeometry.Size(width: 10, height: 10)
        let scale = AvatarCropGeometry.minimumScale(image: inspection.pixelSize, crop: crop)
        let exported = try AvatarCropExport.exportJPEG(
            data: jpeg,
            crop: crop,
            scale: scale,
            offset: .zero
        )
        let output = try XCTUnwrap(AvatarCropExport.inspect(exported))
        XCTAssertEqual(output.pixelSize.width, Double(AvatarCropGeometry.outputDimension))
        XCTAssertEqual(output.pixelSize.height, Double(AvatarCropGeometry.outputDimension))
        XCTAssertEqual(output.exifOrientation, 1)
    }

    func testAnimatedGIFCannotBeEdited() throws {
        let gif = try AvatarImageFixtures.animatedGIF()
        let inspection = try XCTUnwrap(AvatarCropExport.inspect(gif))
        XCTAssertTrue(inspection.isAnimated)
        XCTAssertGreaterThan(inspection.frameCount, 1)
        XCTAssertFalse(AvatarPhotoPresentation.canEdit(isAnimated: inspection.isAnimated))
        XCTAssertThrowsError(
            try AvatarCropExport.exportJPEG(
                data: gif,
                crop: AvatarCropGeometry.Size(width: 8, height: 8),
                scale: 1,
                offset: .zero
            )
        ) { error in
            XCTAssertEqual(error as? AvatarCropExport.Failure, .animated)
        }
    }

    func testUndecodableDataIsUnavailable() {
        XCTAssertNil(AvatarCropExport.inspect(Data([0x00, 0x01, 0x02])))
        XCTAssertThrowsError(
            try AvatarCropExport.exportJPEG(
                data: Data([0xFF, 0xD8, 0xFF]),
                crop: AvatarCropGeometry.Size(width: 8, height: 8),
                scale: 1,
                offset: .zero
            )
        ) { error in
            XCTAssertEqual(error as? AvatarCropExport.Failure, .undecodable)
        }
    }
}

enum AvatarImageFixtures {
    struct Pixel {
        var red: UInt8
        var green: UInt8
        var blue: UInt8
    }

    static func stillJPEG(width: Int, height: Int) throws -> Data {
        try jpeg(from: solidImage(width: width, height: height, red: 30, green: 140, blue: 80))
    }

    static func horizontalSplitJPEG(width: Int, height: Int) throws -> Data {
        try jpeg(from: splitImage(width: width, height: height, leftRed: true))
    }

    static func orientationSixJPEG(width: Int, height: Int) throws -> Data {
        try jpeg(
            from: solidImage(width: width, height: height, red: 200, green: 10, blue: 10),
            orientation: 6
        )
    }

    static func animatedGIF() throws -> Data {
        let first = solidImage(width: 4, height: 4, red: 255, green: 0, blue: 0)
        let second = solidImage(width: 4, height: 4, red: 0, green: 0, blue: 255)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.gif.identifier as CFString,
            2,
            nil
        ) else {
            throw FixtureError.encode
        }
        let frame: [CFString: Any] = [
            kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.2]
        ]
        CGImageDestinationAddImage(destination, first, frame as CFDictionary)
        CGImageDestinationAddImage(destination, second, frame as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw FixtureError.encode }
        return data as Data
    }

    static func centerPixel(of jpeg: Data) throws -> Pixel {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw FixtureError.decode
        }
        let x = image.width / 2
        let y = image.height / 2
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw FixtureError.decode
        }
        context.draw(image, in: CGRect(x: -x, y: -y, width: image.width, height: image.height))
        return Pixel(red: pixel[0], green: pixel[1], blue: pixel[2])
    }

    private static func jpeg(from image: CGImage, orientation: UInt32 = 1) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw FixtureError.encode
        }
        let properties: [CFString: Any] = [kCGImagePropertyOrientation: orientation]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw FixtureError.encode }
        return data as Data
    }

    private static func solidImage(width: Int, height: Int, red: CGFloat, green: CGFloat, blue: CGFloat) -> CGImage {
        makeImage(width: width, height: height) { context in
            context.setFillColor(CGColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private static func splitImage(width: Int, height: Int, leftRed: Bool) -> CGImage {
        makeImage(width: width, height: height) { context in
            let half = CGFloat(width / 2)
            context.setFillColor(CGColor(red: leftRed ? 1 : 0, green: 0, blue: leftRed ? 0 : 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: half, height: height))
            context.setFillColor(CGColor(red: leftRed ? 0 : 1, green: 0, blue: leftRed ? 1 : 0, alpha: 1))
            context.fill(CGRect(x: half, y: 0, width: CGFloat(width) - half, height: height))
        }
    }

    private static func makeImage(width: Int, height: Int, fill: (CGContext) -> Void) -> CGImage {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        fill(context)
        return context.makeImage()!
    }

    private enum FixtureError: Error {
        case encode
        case decode
    }
}
