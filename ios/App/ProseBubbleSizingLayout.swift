import SwiftUI

/// Sizes prose bubble content by proposing the policy text cap first when
/// intrinsic width exceeds it, so wrapped height and background agree.
struct ProseBubbleSizingLayout: Layout {
    var maxContentWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let cap = min(maxContentWidth, proposal.width ?? maxContentWidth)
        let idealWidth = subview.sizeThatFits(.unspecified).width
        let width = min(max(0, cap), max(0, idealWidth))
        let dimensions = subview.dimensions(in: ProposedViewSize(width: width, height: nil))
        return CGSize(width: width, height: dimensions.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let size = sizeThatFits(proposal: proposal, subviews: subviews, cache: &cache)
        subview.place(
            at: CGPoint(x: bounds.minX, y: bounds.minY),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: size.width, height: size.height)
        )
    }
}

extension View {
    func proseBubbleSized(maxContentWidth: CGFloat) -> some View {
        ProseBubbleSizingLayout(maxContentWidth: maxContentWidth) {
            self
        }
    }
}
