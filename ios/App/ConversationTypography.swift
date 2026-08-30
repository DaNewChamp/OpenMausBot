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

    /// Grok Bot chat body: SF at 17pt, scaled by the conversation-size preference.
    var body: Font { font(size: 17, relativeTo: .body) }
    var heading1: Font { font(size: 22, relativeTo: .title2, weight: .semibold) }
    var heading2: Font { font(size: 19, relativeTo: .headline, weight: .semibold) }
    var heading3: Font { font(size: 17, relativeTo: .headline, weight: .semibold) }
    var code: Font { font(size: 14, relativeTo: .footnote, design: .monospaced) }
    var codeLabel: Font { font(size: 11, relativeTo: .caption2, weight: .medium, design: .monospaced) }
    var detail: Font { font(size: 13, relativeTo: .footnote) }
    var compact: Font { font(size: 12, relativeTo: .caption1, weight: .medium) }
    var composer: Font { font(size: 17, relativeTo: .body) }
    var rosterName: Font { font(size: 17, relativeTo: .body, weight: .semibold) }
    var rosterPreview: Font { font(size: 15, relativeTo: .subheadline) }

    /// Returns a chat-content font that combines the user's conversation-size
    /// preference with the current Dynamic Type category. Keep this helper
    /// available to cards so their text follows the same scaling contract as
    /// Markdown and message bubbles.
    func font(
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

private struct ChatPaneWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = 390
}

extension EnvironmentValues {
    var chatPaneWidth: CGFloat {
        get { self[ChatPaneWidthKey.self] }
        set { self[ChatPaneWidthKey.self] = newValue }
    }
}
