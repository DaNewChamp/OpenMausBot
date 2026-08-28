// Pinch-zoom remote desktop surface for Local VM screenshots. Maps taps and
// drags to harness input actions while the preview stream keeps updating.
import SwiftUI
import UIKit

enum RemoteDesktopInteractionMode: String, CaseIterable, Identifiable {
    case touch
    case mouse

    var id: String { rawValue }

    var label: String {
        switch self {
        case .touch: return "Touch"
        case .mouse: return "Mouse"
        }
    }

    var systemImage: String {
        switch self {
        case .touch: return "hand.tap"
        case .mouse: return "cursorarrow"
        }
    }
}

enum RemoteDesktopScrollDirection: String {
    case up
    case down
}

enum RemoteDesktopInput {
    case click(x: Double, y: Double, button: String, double: Bool)
    case scroll(x: Double, y: Double, direction: RemoteDesktopScrollDirection)
    case type(String)
    case key(String)
}

struct RemoteDesktopCanvas: View {
    let image: UIImage
    let interactive: Bool
    let onInput: (RemoteDesktopInput) -> Void

    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinchScale: CGFloat = 1
    @GestureState private var dragOffset: CGSize = .zero
    @State private var lastDragPoint: CGPoint?

    private let minScale: CGFloat = 1
    private let maxScale: CGFloat = 4

    var body: some View {
        GeometryReader { proxy in
            let fitted = fittedRect(in: proxy.size, imageSize: image.size)
            let liveScale = clampedScale(scale * pinchScale)
            let liveOffset = CGSize(
                width: offset.width + dragOffset.width,
                height: offset.height + dragOffset.height
            )

            Image(uiImage: image)
                .resizable()
                .interpolation(.medium)
                .frame(width: fitted.width, height: fitted.height)
                .scaleEffect(liveScale, anchor: .center)
                .offset(liveOffset)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(panGesture(liveScale: liveScale))
                .simultaneousGesture(magnifyGesture)
                .simultaneousGesture(tapGesture(fitted: fitted, liveScale: liveScale, liveOffset: liveOffset))
                .simultaneousGesture(longPressGesture(fitted: fitted, liveScale: liveScale, liveOffset: liveOffset))
                .accessibilityLabel("Remote desktop")
                .accessibilityHint(interactive ? "Pinch to zoom. Tap to click." : "Watch-only preview")
        }
    }

    private var magnifyGesture: some Gesture {
        MagnificationGesture()
            .updating($pinchScale) { value, state, _ in state = value }
            .onEnded { value in
                scale = clampedScale(scale * value)
            }
    }

    private func panGesture(liveScale: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .updating($dragOffset) { value, state, _ in
                guard liveScale > 1.01 else { return }
                state = value.translation
            }
            .onEnded { value in
                guard liveScale > 1.01 else { return }
                offset = CGSize(
                    width: offset.width + value.translation.width,
                    height: offset.height + value.translation.height
                )
            }
    }

    private func tapGesture(fitted: CGRect, liveScale: CGFloat, liveOffset: CGSize) -> some Gesture {
        SpatialTapGesture(count: 1)
            .onEnded { value in
                guard interactive else { return }
                guard let point = desktopPoint(
                    at: value.location,
                    fitted: fitted,
                    liveScale: liveScale,
                    liveOffset: liveOffset
                ) else { return }
                Haptics.impact(.light)
                onInput(.click(x: point.x, y: point.y, button: "left", double: false))
            }
    }

    private func longPressGesture(fitted: CGRect, liveScale: CGFloat, liveOffset: CGSize) -> some Gesture {
        LongPressGesture(minimumDuration: 0.45)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onEnded { value in
                guard interactive else { return }
                guard case .second(true, let drag?) = value else { return }
                guard let point = desktopPoint(
                    at: drag.location,
                    fitted: fitted,
                    liveScale: liveScale,
                    liveOffset: liveOffset
                ) else { return }
                Haptics.impact(.medium)
                onInput(.click(x: point.x, y: point.y, button: "right", double: false))
            }
    }

    func resetZoom() {
        scale = 1
        offset = .zero
    }

    private func clampedScale(_ value: CGFloat) -> CGFloat {
        min(max(value, minScale), maxScale)
    }

    private func fittedRect(in container: CGSize, imageSize: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let fit = min(container.width / imageSize.width, container.height / imageSize.height)
        let size = CGSize(width: imageSize.width * fit, height: imageSize.height * fit)
        let origin = CGPoint(
            x: (container.width - size.width) / 2,
            y: (container.height - size.height) / 2
        )
        return CGRect(origin: origin, size: size)
    }

    private func desktopPoint(
        at location: CGPoint,
        fitted: CGRect,
        liveScale: CGFloat,
        liveOffset: CGSize
    ) -> CGPoint? {
        let center = CGPoint(x: fitted.midX + liveOffset.width, y: fitted.midY + liveOffset.height)
        let scaledWidth = fitted.width * liveScale
        let scaledHeight = fitted.height * liveScale
        let frame = CGRect(
            x: center.x - scaledWidth / 2,
            y: center.y - scaledHeight / 2,
            width: scaledWidth,
            height: scaledHeight
        )
        guard frame.contains(location) else { return nil }
        let normalizedX = (location.x - frame.minX) / frame.width
        let normalizedY = (location.y - frame.minY) / frame.height
        return CGPoint(
            x: normalizedX * image.size.width,
            y: normalizedY * image.size.height
        )
    }
}
