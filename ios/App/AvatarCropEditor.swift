import CompanionCore
import SwiftUI
import UIKit

enum AvatarCropPreviewMask: Equatable {
    case circle
    case rounded
    case square
}

private final class AvatarCropTransform {
    var scale: Double = 1
    var offset = AvatarCropGeometry.Offset.zero
    var imageSize = AvatarCropGeometry.Size(width: 1, height: 1)
    var cropSize = AvatarCropGeometry.Size(width: 1, height: 1)
}

/// Native pinch-zoom / pan crop editor used by Account Profile and Bot Profile.
struct AvatarCropEditor: View {
    let imageData: Data
    var previewMask: AvatarCropPreviewMask = .circle
    var onCancel: () -> Void
    var onUsePhoto: (Data) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var image: UIImage?
    @State private var inspection: AvatarCropExport.Inspection?
    @State private var transform = AvatarCropTransform()
    @State private var resetToken = 0
    @State private var exportError: String?

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let cropSide = cropSideLength(in: geo.size)
                VStack(spacing: 16) {
                    Spacer(minLength: 8)
                    ZStack {
                        if let image {
                            AvatarCropCanvas(
                                image: image,
                                resetToken: resetToken,
                                reduceMotion: reduceMotion,
                                onTransformChange: { nextScale, nextOffset, nextImage, nextCrop in
                                    transform.scale = nextScale
                                    transform.offset = nextOffset
                                    transform.imageSize = nextImage
                                    transform.cropSize = nextCrop
                                }
                            )
                            .frame(width: cropSide, height: cropSide)
                            .accessibilityLabel(AvatarPhotoPresentation.editorTitle)
                            .accessibilityHint(AvatarPhotoPresentation.cropCanvasHint)
                            .accessibilityAddTraits(.isImage)

                            cropChrome(side: cropSide)
                                .allowsHitTesting(false)
                        }
                    }
                    .frame(width: cropSide, height: cropSide)

                    Button(AvatarPhotoPresentation.resetTitle) {
                        resetToken += 1
                    }
                    .font(.body)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                    .accessibilityHint(AvatarPhotoPresentation.resetHint)

                    if let exportError {
                        Text(exportError)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    }

                    Spacer(minLength: 8)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(VBotSurface.background.ignoresSafeArea())
            .navigationTitle(AvatarPhotoPresentation.editorTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(AvatarPhotoPresentation.cancelTitle, action: onCancel)
                        .accessibilityHint(AvatarPhotoPresentation.cancelHint)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(AvatarPhotoPresentation.usePhotoTitle, action: usePhoto)
                        .fontWeight(.semibold)
                        .disabled(image == nil)
                        .accessibilityHint(AvatarPhotoPresentation.usePhotoHint)
                }
            }
        }
        .presentationDragIndicator(.visible)
        .onAppear(perform: loadImage)
    }

    @ViewBuilder
    private func cropChrome(side: CGFloat) -> some View {
        let rect = CGRect(x: 0, y: 0, width: side, height: side)
        ZStack {
            Rectangle()
                .fill(.black.opacity(0.45))
                .mask {
                    Rectangle()
                        .overlay(alignment: .center) {
                            holePath(in: rect)
                                .fill()
                                .blendMode(.destinationOut)
                        }
                        .compositingGroup()
                }
            holePath(in: rect)
                .stroke(Color.white.opacity(0.92), lineWidth: 2)
        }
        .frame(width: side, height: side)
        .allowsHitTesting(false)
    }

    private func holePath(in rect: CGRect) -> Path {
        switch previewMask {
        case .circle:
            return Path(ellipseIn: rect.insetBy(dx: 1, dy: 1))
        case .rounded:
            return RoundedRectangle(cornerRadius: rect.width * 0.22, style: .continuous)
                .path(in: rect.insetBy(dx: 1, dy: 1))
        case .square:
            return Path(rect.insetBy(dx: 1, dy: 1))
        }
    }

    private func cropSideLength(in size: CGSize) -> CGFloat {
        let reserved: CGFloat = dynamicTypeSize.isAccessibilitySize ? 220 : 180
        return max(160, min(size.width - 32, size.height - reserved))
    }

    private func loadImage() {
        if let inspection = AvatarCropExport.inspect(imageData), inspection.isAnimated {
            exportError = AvatarPhotoPresentation.animatedRejectionMessage
            return
        }
        inspection = AvatarCropExport.inspect(imageData)
        image = UIImage(data: imageData)
        if image == nil {
            exportError = "That photo could not be opened."
        }
    }

    private func usePhoto() {
        guard let inspection else {
            exportError = "That photo could not be opened."
            return
        }
        let ratio = inspection.pixelSize.width / max(transform.imageSize.width, 1)
        do {
            let jpeg = try AvatarCropExport.exportJPEG(
                data: imageData,
                crop: AvatarCropGeometry.Size(
                    width: transform.cropSize.width * ratio,
                    height: transform.cropSize.height * ratio
                ),
                scale: transform.scale,
                offset: AvatarCropGeometry.Offset(
                    x: transform.offset.x * ratio,
                    y: transform.offset.y * ratio
                )
            )
            onUsePhoto(jpeg)
        } catch AvatarCropExport.Failure.animated {
            exportError = AvatarPhotoPresentation.animatedRejectionMessage
        } catch {
            exportError = "That photo could not be cropped."
        }
    }
}

private struct AvatarCropCanvas: UIViewRepresentable {
    var image: UIImage
    var resetToken: Int
    var reduceMotion: Bool
    var onTransformChange: (Double, AvatarCropGeometry.Offset, AvatarCropGeometry.Size, AvatarCropGeometry.Size) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> AvatarCropHostView {
        let host = AvatarCropHostView()
        host.onChange = onTransformChange
        host.reduceMotion = reduceMotion
        host.setImage(image)
        context.coordinator.host = host
        context.coordinator.resetToken = resetToken
        return host
    }

    func updateUIView(_ host: AvatarCropHostView, context: Context) {
        host.onChange = onTransformChange
        host.reduceMotion = reduceMotion
        if host.image !== image {
            host.setImage(image)
        }
        if context.coordinator.resetToken != resetToken {
            context.coordinator.resetToken = resetToken
            host.reset(animated: !reduceMotion)
        }
    }

    final class Coordinator {
        var host: AvatarCropHostView?
        var resetToken = 0
    }
}

private final class AvatarCropHostView: UIView, UIScrollViewDelegate {
    let scrollView = UIScrollView()
    let imageView = UIImageView()
    private(set) var image: UIImage?
    var reduceMotion = false
    var onChange: ((Double, AvatarCropGeometry.Offset, AvatarCropGeometry.Size, AvatarCropGeometry.Size) -> Void)?
    private var lastLaidOutSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        scrollView.delegate = self
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.decelerationRate = .fast
        imageView.isUserInteractionEnabled = false
        scrollView.addSubview(imageView)
        addSubview(scrollView)
        clipsToBounds = true
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { nil }

    func setImage(_ image: UIImage) {
        self.image = image
        imageView.image = image
        imageView.frame = CGRect(origin: .zero, size: image.size)
        scrollView.contentSize = image.size
        lastLaidOutSize = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds
        guard let image, bounds.width > 1, bounds.height > 1 else { return }
        let minScale = max(bounds.width / image.size.width, bounds.height / image.size.height)
        scrollView.minimumZoomScale = minScale
        scrollView.maximumZoomScale = max(minScale * 8, 4)
        if lastLaidOutSize != bounds.size {
            lastLaidOutSize = bounds.size
            scrollView.setZoomScale(minScale, animated: false)
            centerContent()
        }
        report()
    }

    func reset(animated: Bool) {
        let minScale = scrollView.minimumZoomScale
        let apply = {
            self.scrollView.setZoomScale(minScale, animated: false)
            self.centerContent()
        }
        if animated {
            UIView.animate(withDuration: 0.22, animations: apply) { _ in
                self.report()
            }
        } else {
            apply()
            report()
        }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        report()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        report()
    }

    private func centerContent() {
        guard let image else { return }
        let scaled = CGSize(
            width: image.size.width * scrollView.zoomScale,
            height: image.size.height * scrollView.zoomScale
        )
        scrollView.contentOffset = CGPoint(
            x: max(0, (scaled.width - bounds.width) / 2),
            y: max(0, (scaled.height - bounds.height) / 2)
        )
    }

    private func report() {
        guard let image, bounds.width > 0, bounds.height > 0 else { return }
        let crop = AvatarCropGeometry.Size(width: bounds.width, height: bounds.height)
        let imageSize = AvatarCropGeometry.Size(width: image.size.width, height: image.size.height)
        let displayedWidth = image.size.width * scrollView.zoomScale
        let displayedHeight = image.size.height * scrollView.zoomScale
        let offset = AvatarCropGeometry.Offset(
            x: Double((displayedWidth - bounds.width) / 2 - scrollView.contentOffset.x),
            y: Double((displayedHeight - bounds.height) / 2 - scrollView.contentOffset.y)
        )
        onChange?(Double(scrollView.zoomScale), offset, imageSize, crop)
    }
}

#if DEBUG
struct AvatarCropPreviewHost: View {
    var body: some View {
        AvatarCropEditor(
            imageData: Self.sampleJPEG(),
            previewMask: .circle,
            onCancel: {},
            onUsePhoto: { _ in }
        )
    }

    private static func sampleJPEG() -> Data {
        let size = CGSize(width: 480, height: 320)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: size.width / 2, height: size.height))
        }
        return image.jpegData(compressionQuality: 0.9) ?? Data()
    }
}
#endif
