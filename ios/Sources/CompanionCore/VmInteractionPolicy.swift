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

/// Pure presentation and dismissal policies for the Local VM software keyboard.
public enum VmKeyboardPresentationPolicy: Sendable {
    public struct State: Equatable, Sendable {
        public var isPresented: Bool
        public var draftText: String

        public init(isPresented: Bool = false, draftText: String = "") {
            self.isPresented = isPresented
            self.draftText = draftText
        }
    }

    public enum Event: Equatable, Sendable {
        case dismiss
        case toggle(canType: Bool)
        case back
        case leavingComputer
        case destinationChange(from: String?, to: String?)
    }

    public static func transition(state: State, event: Event) -> State {
        switch event {
        case .dismiss, .back, .leavingComputer:
            return State(isPresented: false, draftText: "")
        case let .toggle(canType):
            if state.isPresented {
                return State(isPresented: false, draftText: "")
            } else {
                return State(isPresented: canType, draftText: state.draftText)
            }
        case let .destinationChange(from, to):
            let trimmedFrom = from?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let trimmedTo = to?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if trimmedFrom != trimmedTo {
                return State(isPresented: false, draftText: "")
            }
            return state
        }
    }
}
