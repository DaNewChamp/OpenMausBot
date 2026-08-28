import SwiftUI
import UIKit

/// Screenshot-based Local VM input: pinch/pan the preview, tap to click,
/// long-press for right click, vertical drag to scroll. Shows a desktop
/// cursor where the VM will be clicked.
struct RemoteDesktopCanvas: View {
    let image: UIImage
    let onClick: (_ x: Int, _ y: Int, _ button: String) -> Void
    let onScroll: (_ direction: String, _ clicks: Int, _ x: Int, _ y: Int) -> Void

    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var cursorPoint: CGPoint?
    @GestureState private var dragOffset: CGSize = .zero
    @GestureState private var pinchScale: CGFloat = 1

    var body: some View {
        GeometryReader { proxy in
            let fitted = fittedSize(for: image.size, in: proxy.size)
            ZStack {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: fitted.width * scale * pinchScale, height: fitted.height * scale * pinchScale)
                    .offset(x: offset.width + dragOffset.width, y: offset.height + dragOffset.height)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(combinedGesture(fitted: fitted, container: proxy.size))

                if let cursorPoint {
                    Image(systemName: "cursorarrow")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.8), radius: 2, x: 0, y: 1)
                        .position(cursorPoint)
                        .allowsHitTesting(false)
                }
            }
        }
        .clipped()
    }

    private func fittedSize(for imageSize: CGSize, in container: CGSize) -> CGSize {
        guard imageSize.width > 0, imageSize.height > 0 else { return container }
        let widthRatio = container.width / imageSize.width
        let heightRatio = container.height / imageSize.height
        let ratio = min(widthRatio, heightRatio)
        return CGSize(width: imageSize.width * ratio, height: imageSize.height * ratio)
    }

    private func combinedGesture(fitted: CGSize, container: CGSize) -> some Gesture {
        let magnification = MagnificationGesture()
            .updating($pinchScale) { value, state, _ in state = value }
            .onEnded { value in scale = min(max(scale * value, 1), 4) }

        let pan = DragGesture(minimumDistance: 12)
            .updating($dragOffset) { value, state, _ in state = value.translation }
            .onEnded { value in
                if value.translation.height < -24, abs(value.translation.width) < 40 {
                    let point = desktopPoint(from: value.startLocation, fitted: fitted, container: container)
                    cursorPoint = value.startLocation
                    onScroll("up", 3, point.x, point.y)
                    return
                }
                if value.translation.height > 24, abs(value.translation.width) < 40 {
                    let point = desktopPoint(from: value.startLocation, fitted: fitted, container: container)
                    cursorPoint = value.startLocation
                    onScroll("down", 3, point.x, point.y)
                    return
                }
                offset.width += value.translation.width
                offset.height += value.translation.height
            }

        let tap = SpatialTapGesture()
            .onEnded { value in
                cursorPoint = value.location
                let point = desktopPoint(from: value.location, fitted: fitted, container: container)
                onClick(point.x, point.y, "left")
            }

        let longPress = LongPressGesture(minimumDuration: 0.45)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onEnded { value in
                guard case .second(true, let drag?) = value else { return }
                cursorPoint = drag.startLocation
                let point = desktopPoint(from: drag.startLocation, fitted: fitted, container: container)
                onClick(point.x, point.y, "right")
            }

        return tap.simultaneously(with: longPress)
            .simultaneously(with: pan)
            .simultaneously(with: magnification)
    }

    private func desktopPoint(from location: CGPoint, fitted: CGSize, container: CGSize) -> (x: Int, y: Int) {
        let rendered = CGSize(width: fitted.width * scale * pinchScale, height: fitted.height * scale * pinchScale)
        let origin = CGPoint(
            x: (container.width - rendered.width) / 2 + offset.width,
            y: (container.height - rendered.height) / 2 + offset.height
        )
        let localX = max(0, min(rendered.width, location.x - origin.x))
        let localY = max(0, min(rendered.height, location.y - origin.y))
        let x = Int((localX / rendered.width) * image.size.width)
        let y = Int((localY / rendered.height) * image.size.height)
        return (max(0, x), max(0, y))
    }
}
