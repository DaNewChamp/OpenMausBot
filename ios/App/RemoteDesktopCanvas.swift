import SwiftUI
import UIKit
import CompanionCore

/// Screenshot-based Local VM input: pinch/pan the preview, tap to click,
/// long-press for right click, vertical drag to scroll. Shows a desktop
/// cursor where the VM will be clicked.
struct RemoteDesktopCanvas: View {
    let image: UIImage
    var pointerMode: VmPointerMode = .touch
    let onClick: (_ x: Int, _ y: Int, _ button: String) -> Void
    let onScroll: (_ direction: String, _ clicks: Int, _ x: Int, _ y: Int) -> Void

    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var cursorPoint: CGPoint?
    @State private var trackpadStartLocation: CGPoint?
    @State private var trackpadStartCursor: CGPoint?
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
            .onAppear {
                if cursorPoint == nil {
                    cursorPoint = clampedCursor(
                        CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2),
                        fitted: fitted,
                        container: proxy.size
                    )
                }
            }
            .onChange(of: pointerMode) { _, _ in
                trackpadStartLocation = nil
                trackpadStartCursor = nil
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

        let pan = DragGesture(minimumDistance: pointerMode == .trackpad ? 0 : 12)
            .updating($dragOffset) { value, state, _ in
                if pointerMode != .trackpad {
                    state = value.translation
                }
            }
            .onChanged { value in
                guard pointerMode == .trackpad else { return }
                if trackpadStartLocation == nil {
                    trackpadStartLocation = value.startLocation
                    trackpadStartCursor = cursorPoint ?? CGPoint(x: container.width / 2, y: container.height / 2)
                }
                guard let startLocation = trackpadStartLocation,
                      let startCursor = trackpadStartCursor
                else { return }
                cursorPoint = VmInteractionPolicy.trackpadCursor(
                    initialCursor: startCursor,
                    startLocation: startLocation,
                    location: value.location,
                    bounds: desktopRect(fitted: fitted, container: container).insetBy(dx: 1, dy: 1)
                )
            }
            .onEnded { value in
                if pointerMode == .trackpad {
                    trackpadStartLocation = nil
                    trackpadStartCursor = nil
                    return
                }
                if value.translation.height < -24, abs(value.translation.width) < 40 {
                    let point = desktopPoint(from: value.startLocation, fitted: fitted, container: container)
                    cursorPoint = clampedCursor(value.startLocation, fitted: fitted, container: container)
                    onScroll("up", 3, point.x, point.y)
                    return
                }
                if value.translation.height > 24, abs(value.translation.width) < 40 {
                    let point = desktopPoint(from: value.startLocation, fitted: fitted, container: container)
                    cursorPoint = clampedCursor(value.startLocation, fitted: fitted, container: container)
                    onScroll("down", 3, point.x, point.y)
                    return
                }
                offset.width += value.translation.width
                offset.height += value.translation.height
            }

        let tap = SpatialTapGesture()
            .onEnded { value in
                if pointerMode == .trackpad, let cursorPoint {
                    let point = desktopPoint(from: cursorPoint, fitted: fitted, container: container)
                    onClick(point.x, point.y, "left")
                } else {
                    cursorPoint = clampedCursor(value.location, fitted: fitted, container: container)
                    let point = desktopPoint(from: value.location, fitted: fitted, container: container)
                    onClick(point.x, point.y, "left")
                }
            }

        let longPress = LongPressGesture(minimumDuration: 0.45)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onEnded { value in
                guard case .second(true, let drag?) = value else { return }
                let location = pointerMode == .trackpad ? (cursorPoint ?? drag.startLocation) : drag.startLocation
                cursorPoint = clampedCursor(location, fitted: fitted, container: container)
                let point = desktopPoint(from: location, fitted: fitted, container: container)
                onClick(point.x, point.y, "right")
            }

        return tap.simultaneously(with: longPress)
            .simultaneously(with: pan)
            .simultaneously(with: magnification)
    }

    private func desktopPoint(from location: CGPoint, fitted: CGSize, container: CGSize) -> (x: Int, y: Int) {
        let rect = desktopRect(fitted: fitted, container: container)
        let rendered = rect.size
        let origin = rect.origin
        let localX = max(0, min(rendered.width, location.x - origin.x))
        let localY = max(0, min(rendered.height, location.y - origin.y))
        let x = Int((localX / rendered.width) * image.size.width)
        let y = Int((localY / rendered.height) * image.size.height)
        return (max(0, x), max(0, y))
    }

    private func desktopRect(fitted: CGSize, container: CGSize) -> CGRect {
        let rendered = CGSize(width: fitted.width * scale * pinchScale, height: fitted.height * scale * pinchScale)
        return CGRect(
            x: (container.width - rendered.width) / 2 + offset.width,
            y: (container.height - rendered.height) / 2 + offset.height,
            width: rendered.width,
            height: rendered.height
        )
    }

    private func clampedCursor(_ location: CGPoint, fitted: CGSize, container: CGSize) -> CGPoint {
        let bounds = desktopRect(fitted: fitted, container: container).insetBy(dx: 1, dy: 1)
        return CGPoint(
            x: min(max(location.x, bounds.minX), bounds.maxX),
            y: min(max(location.y, bounds.minY), bounds.maxY)
        )
    }
}
