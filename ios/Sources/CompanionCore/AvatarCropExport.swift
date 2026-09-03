import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum AvatarCropExport: Sendable {
    public enum Failure: Error, Equatable, Sendable {
        case undecodable
        case animated
    }

    public struct Inspection: Equatable, Sendable {
        public var pixelSize: AvatarCropGeometry.Size
        public var frameCount: Int
        public var exifOrientation: Int
        public var isAnimated: Bool { frameCount > 1 }
    }

    public static func isJPEG(_ data: Data) -> Bool {
        data.count >= 3
            && data[data.startIndex] == 0xFF
            && data[data.startIndex + 1] == 0xD8
            && data[data.startIndex + 2] == 0xFF
    }

    public static func inspect(_ data: Data) -> Inspection? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, nil)
        else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count >= 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = intValue(properties[kCGImagePropertyPixelWidth]),
              let height = intValue(properties[kCGImagePropertyPixelHeight]),
              width > 0,
              height > 0
        else { return nil }
        let orientation = intValue(properties[kCGImagePropertyOrientation]) ?? 1
        let pixel = AvatarCropGeometry.Size(width: Double(width), height: Double(height))
        return Inspection(
            pixelSize: AvatarCropGeometry.orientedSize(pixel: pixel, exifOrientation: orientation),
            frameCount: count,
            exifOrientation: orientation
        )
    }

    public static func exportJPEG(
        data: Data,
        crop: AvatarCropGeometry.Size,
        scale: Double,
        offset: AvatarCropGeometry.Offset
    ) throws -> Data {
        guard let inspection = inspect(data) else { throw Failure.undecodable }
        guard AvatarPhotoPresentation.canEdit(isAnimated: inspection.isAnimated) else {
            throw Failure.animated
        }
        guard let image = orientedImage(from: data) else { throw Failure.undecodable }
        let imageSize = AvatarCropGeometry.Size(
            width: Double(image.width),
            height: Double(image.height)
        )
        let rect = AvatarCropGeometry.sourceRect(
            image: imageSize,
            crop: crop,
            scale: scale,
            offset: offset
        )
        let bounds = CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height))
        let clipped = rect.intersection(bounds)
        guard clipped.width >= 0.5, clipped.height >= 0.5,
              let cropped = image.cropping(to: pixelRect(clipped, in: bounds))
        else {
            throw Failure.undecodable
        }
        let dimension = AvatarCropGeometry.outputDimension
        guard let scaled = redraw(cropped, width: dimension, height: dimension) else {
            throw Failure.undecodable
        }
        return try jpegData(from: scaled, quality: AvatarCropGeometry.jpegQuality)
    }

    private static func orientedImage(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let width = intValue(properties?[kCGImagePropertyPixelWidth]) ?? 0
        let height = intValue(properties?[kCGImagePropertyPixelHeight]) ?? 0
        let maxEdge = max(width, height, 1)
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static func pixelRect(_ rect: CGRect, in bounds: CGRect) -> CGRect {
        var pixel = rect.integral
        if pixel.width < 1 { pixel.size.width = 1 }
        if pixel.height < 1 { pixel.size.height = 1 }
        return pixel.intersection(bounds)
    }

    private static func redraw(_ image: CGImage, width: Int, height: Int) -> CGImage? {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        return context.makeImage()
    }

    private static func jpegData(from image: CGImage, quality: CGFloat) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw Failure.undecodable
        }
        let properties: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: quality,
            kCGImagePropertyOrientation: 1,
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure.undecodable }
        return data as Data
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? Int { return number }
        if let number = value as? NSNumber { return number.intValue }
        return nil
    }
}
