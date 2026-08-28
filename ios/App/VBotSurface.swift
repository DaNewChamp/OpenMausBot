import SwiftUI
import UIKit

/// Shared near-black / paper canvas for home, chat, settings, and profiles.
/// Dark mode tracks the official Grok Bot canvas (true black, not lifted
/// charcoal). Light mode keeps a quiet paper gray so contrast is not
/// invented twice per screen.
enum VBotSurface {
    static let background = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.000, green: 0.000, blue: 0.000, alpha: 1) // #000000
            : UIColor(red: 0.965, green: 0.965, blue: 0.973, alpha: 1) // #F6F6F8
    })

    static let assistantBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1) // #1C1C1E
            : UIColor(red: 0.898, green: 0.898, blue: 0.914, alpha: 1) // #E5E5E9
    })

    static let controlSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1) // #1C1C1E
            : UIColor(red: 0.882, green: 0.882, blue: 0.898, alpha: 1) // #E1E1E5
    })

    static let composerSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.173, green: 0.173, blue: 0.180, alpha: 1) // #2C2C2E
            : UIColor(red: 0.914, green: 0.914, blue: 0.929, alpha: 1) // #E9E9ED
    })

    /// User bubbles on the Grok canvas: a lifted gray, never a brand fill.
    static let userBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.173, green: 0.173, blue: 0.180, alpha: 1) // #2C2C2E
            : UIColor(red: 0.227, green: 0.243, blue: 0.275, alpha: 1) // #3A3E46
    })

    /// Roster unread mark. The reference uses system blue, not the bot color.
    static let unread = Color(uiColor: .systemBlue)

    static let card = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1)
            : UIColor.secondarySystemBackground
    })
}
