import SwiftUI
import CompanionCore

/// The shared typography used by conversation content. Navigation chrome and
/// controls stay on their normal Dynamic Type styles; only chat content reads
/// this environment value.
struct ConversationTypography: Equatable {
    let scale: CGFloat

    init(scale: CGFloat = ConversationTextSize.standard.scale) {
        self.scale = scale
    }

    init(size: ConversationTextSize) {
        self.init(scale: size.scale)
    }

    var body: Font { .system(size: 17 * scale) }
    var heading1: Font { .system(size: 21 * scale, weight: .semibold) }
    var heading2: Font { .system(size: 19 * scale, weight: .semibold) }
    var heading3: Font { .system(size: 17 * scale, weight: .semibold) }
    var code: Font { .system(size: 14 * scale, design: .monospaced) }
    var codeLabel: Font { .system(size: 11 * scale, weight: .medium, design: .monospaced) }
    var detail: Font { .system(size: 13 * scale) }
    var compact: Font { .system(size: 12 * scale, weight: .medium) }
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
