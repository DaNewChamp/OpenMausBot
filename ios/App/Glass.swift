// The one material the chrome is made of.
//
// Every floating control — the header tiles, the Updates pill, the round
// buttons, the sheets, the chat's back pill and composer — is the same glass,
// so the app reads as one object rather than a collection of buttons. On
// iOS 26 it is the system's Liquid Glass, which refracts what scrolls
// beneath it; before that, a thin material with a hairline does the same
// job in the same shape, just without the light.
import SwiftUI
import CompanionCore

/// Something floating over content: a tile, a pill, a sheet.
struct GlassSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    var interactive: Bool = true
    var tint: Color? = nil

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            let base: Glass = interactive ? .regular.interactive() : .regular
            content.glassEffect(tint.map { base.tint($0) } ?? base, in: shape)
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .background(tint?.opacity(0.18) ?? Color.primary.opacity(0.06), in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
        }
    }
}

/// Glass as a backdrop so labels and fills paint on top of it. `glassEffect`
/// applied to the content itself turns `Color.primary` into a grey
/// vibrancy sample — that is why the send disc stayed grey with text in it.
private struct GlassBackdrop<S: InsettableShape>: ViewModifier {
    let shape: S
    var interactive: Bool = true

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            let glass: Glass = interactive ? .regular.interactive() : .regular
            content.background { shape.fill(.clear).glassEffect(glass, in: shape) }
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
        }
    }
}

extension View {
    /// A capsule of glass — pills and round buttons.
    func glassCapsule(interactive: Bool = true, tint: Color? = nil) -> some View {
        modifier(GlassSurface(shape: Capsule(), interactive: interactive, tint: tint))
    }

    /// Glass behind the content, not through it. Use this when a child
    /// (the send disc) must stay opaque white instead of picking up vibrancy.
    func glassCapsuleBackdrop(interactive: Bool = true) -> some View {
        modifier(GlassBackdrop(shape: Capsule(), interactive: interactive))
    }

    /// A circular glass control. Same material as `glassCapsule`, locked to a circle
    /// so square frames (the 44pt chrome) stay round.
    func glassCircle(interactive: Bool = true, tint: Color? = nil) -> some View {
        modifier(GlassSurface(shape: Circle(), interactive: interactive, tint: tint))
    }

    /// A rounded sheet of glass.
    func glassSheet(cornerRadius: CGFloat = VBotSurface.Radius.sheet, tint: Color? = nil) -> some View {
        modifier(GlassSurface(
            shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
            interactive: false,
            tint: tint
        ))
    }

    /// Card-sized glass, matching `VBotSurface.Radius.card`.
    func glassCard(tint: Color? = nil) -> some View {
        glassSheet(cornerRadius: VBotSurface.Radius.card, tint: tint)
    }
}

/// Neighbouring glass merges when it touches, the way it does in the
/// system's own bars. A no-op before iOS 26.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder let content: () -> Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing, content: content)
        } else {
            content()
        }
    }
}

/// A round glass button with one glyph — the shape of every action in the
/// chrome that is not a pill.
struct GlassButton: View {
    let systemImage: String
    var size: CGFloat = 44
    var weight: Font.Weight = .medium
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.42, weight: weight))
                .foregroundStyle(Color.primary)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCircle()
        .frame(minWidth: VBotSurface.Hit.minimum, minHeight: VBotSurface.Hit.minimum)
    }
}

/// Glass glyph for `Menu` labels — not a nested `Button`.
struct GlassChromeGlyph: View {
    let systemImage: String
    var size: CGFloat = VBotSurface.Hit.minimum
    var weight: Font.Weight = .semibold

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 17, weight: weight))
            .foregroundStyle(Color.primary)
            .frame(width: size, height: size)
            .contentShape(Circle())
            .glassCircle()
            .accessibilityHidden(true)
    }
}

/// A soft material fade for chrome that floats over a scrolling transcript.
struct ScrollEdgeChrome<Content: View>: View {
    var edge: Edge = .top
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .background(alignment: edge == .top ? .top : .bottom) {
                LinearGradient(
                    stops: [
                        .init(color: Color.black.opacity(0.88), location: 0),
                        .init(color: Color.black.opacity(0.62), location: 0.2),
                        .init(color: Color.black.opacity(0.24), location: 0.4),
                        .init(color: .clear, location: 0.62),
                    ],
                    startPoint: edge == .top ? .top : .bottom,
                    endPoint: edge == .top ? .bottom : .top
                )
                .frame(height: ConversationLayoutPolicy.headerScrimHeight)
                .frame(maxWidth: .infinity)
                .ignoresSafeArea(.container, edges: edge == .top ? .top : .bottom)
                .allowsHitTesting(false)
            }
    }
}
