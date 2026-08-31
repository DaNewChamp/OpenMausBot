import CoreGraphics

/// Pure geometry and display policies shared by Local VM input surfaces.
public enum VmInteractionPolicy: Sendable {
    /// Move the remote pointer by the finger's translation from the pointer's
    /// existing location. The bounds are the rendered desktop, not the whole
    /// viewer, so the cursor never jumps under the finger or leaves the image.
    public static func trackpadCursor(
        initialCursor: CGPoint,
        startLocation: CGPoint,
        location: CGPoint,
        bounds: CGRect
    ) -> CGPoint {
        let translated = CGPoint(
            x: initialCursor.x + location.x - startLocation.x,
            y: initialCursor.y + location.y - startLocation.y
        )
        return CGPoint(
            x: min(max(translated.x, bounds.minX), bounds.maxX),
            y: min(max(translated.y, bounds.minY), bounds.maxY)
        )
    }
}

/// Home pinned-conversation captions intentionally show only the display
/// name. Titles remain profile metadata used for hierarchy and routing.
public enum PinnedChatCaptionPolicy: Sendable {
    public static func caption(name: String, title _: String) -> String {
        name
    }
}
