import SwiftUI
import CompanionCore
import UIKit

/// The shared typography used by conversation content. Navigation chrome and
/// controls stay on their normal Dynamic Type styles; only chat content reads
/// this environment value.
struct ConversationTypography: Equatable {
    let scale: CGFloat
    private let dynamicTypeSize: DynamicTypeSize

    init(
        scale: CGFloat = ConversationTextSize.standard.scale,
        dynamicTypeSize: DynamicTypeSize = .large
    ) {
        self.scale = scale
        self.dynamicTypeSize = dynamicTypeSize
    }

    init(size: ConversationTextSize, dynamicTypeSize: DynamicTypeSize = .large) {
        self.init(scale: size.scale, dynamicTypeSize: dynamicTypeSize)
    }

    var body: Font { system(size: 17, relativeTo: .body) }
    var heading1: Font { system(size: 21, relativeTo: .title2, weight: .semibold) }
    var heading2: Font { system(size: 19, relativeTo: .headline, weight: .semibold) }
    var heading3: Font { system(size: 17, relativeTo: .headline, weight: .semibold) }
    var code: Font { system(size: 14, relativeTo: .footnote, design: .monospaced) }
    var codeLabel: Font { system(size: 11, relativeTo: .caption2, weight: .medium, design: .monospaced) }
    var detail: Font { system(size: 13, relativeTo: .footnote) }
    var compact: Font { system(size: 12, relativeTo: .caption1, weight: .medium) }

    private func system(
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle,
        weight: Font.Weight = .regular,
        design: Font.Design = .default
    ) -> Font {
        let traitCollection = UITraitCollection(preferredContentSizeCategory: dynamicTypeSize.contentSizeCategory)
        let pointSize = UIFontMetrics(forTextStyle: textStyle)
            .scaledValue(for: size * scale, compatibleWith: traitCollection)
        return .system(size: pointSize, weight: weight, design: design)
    }
}

private extension DynamicTypeSize {
    var contentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

private struct ConversationTypographyKey: EnvironmentKey {
    static let defaultValue = ConversationTypography()
}

extension EnvironmentValues {
    var conversationTypography: ConversationTypography {
        get { self[ConversationTypographyKey.self] }
        set { self[ConversationTypographyKey.self] = newValue }
    }
}

extension View {
    func conversationTypography(_ typography: ConversationTypography) -> some View {
        environment(\.conversationTypography, typography)
    }
}
