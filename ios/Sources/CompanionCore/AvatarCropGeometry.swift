import CoreGraphics
import Foundation

/// Shared crop-window math for owner and bot avatar photos.
/// Scale is viewport units per image pixel; offset is the image translation
/// from the crop-window center. Minimum scale is aspect-fill so the window
/// never shows an empty edge.
public enum AvatarCropGeometry: Sendable {
    public static let outputDimension = 1_024
    public static let jpegQuality: CGFloat = 0.86
    public static let exportMIME = "image/jpeg"

    public struct Size: Equatable, Sendable {
        public var width: Double
        public var height: Double

        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }
    }

    public struct Offset: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public static let zero = Offset(x: 0, y: 0)

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public static func minimumScale(image: Size, crop: Size) -> Double {
        guard image.width > 0, image.height > 0, crop.width > 0, crop.height > 0 else {
            return 1
        }
        return max(crop.width / image.width, crop.height / image.height)
    }

    public static func clampedScale(_ scale: Double, image: Size, crop: Size) -> Double {
        max(scale, minimumScale(image: image, crop: crop))
    }

    public static func maxOffset(scale: Double, image: Size, crop: Size) -> Offset {
        let scaledWidth = image.width * scale
        let scaledHeight = image.height * scale
        return Offset(
            x: max(0, (scaledWidth - crop.width) / 2),
            y: max(0, (scaledHeight - crop.height) / 2)
        )
    }

    public static func clampedOffset(_ offset: Offset, scale: Double, image: Size, crop: Size) -> Offset {
        let limit = maxOffset(scale: scale, image: image, crop: crop)
        return Offset(
            x: min(max(offset.x, -limit.x), limit.x),
            y: min(max(offset.y, -limit.y), limit.y)
        )
    }

    /// Crop rectangle in image-pixel space, origin top-left.
    public static func sourceRect(
        image: Size,
        crop: Size,
        scale: Double,
        offset: Offset
    ) -> CGRect {
        let scale = clampedScale(scale, image: image, crop: crop)
        let offset = clampedOffset(offset, scale: scale, image: image, crop: crop)
        let displayedWidth = image.width * scale
        let displayedHeight = image.height * scale
        let originX = (crop.width - displayedWidth) / 2 + offset.x
        let originY = (crop.height - displayedHeight) / 2 + offset.y
        return CGRect(
            x: (0 - originX) / scale,
            y: (0 - originY) / scale,
            width: crop.width / scale,
            height: crop.height / scale
        )
    }

    public static func resetTransform(image: Size, crop: Size) -> (scale: Double, offset: Offset) {
        (minimumScale(image: image, crop: crop), .zero)
    }

    /// EXIF orientations 5–8 are 90° / transposed and swap stored width/height.
    public static func orientedSize(pixel: Size, exifOrientation: Int) -> Size {
        switch exifOrientation {
        case 5, 6, 7, 8:
            return Size(width: pixel.height, height: pixel.width)
        default:
            return Size(width: pixel.width, height: pixel.height)
        }
    }
}
