import SwiftUI
import UIKit

/// Shared black / graphite canvas for home, chat, settings, and profiles.
/// Dark mode stays near the master icon's matte black; light mode keeps a
/// quiet paper gray so contrast is not invented twice per screen.
enum VBotSurface {
    static let background = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.071, green: 0.071, blue: 0.078, alpha: 1) // #121214
            : UIColor(red: 0.965, green: 0.965, blue: 0.973, alpha: 1) // #F6F6F8
    })

    static let assistantBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.118, green: 0.118, blue: 0.129, alpha: 1) // #1E1E21
            : UIColor(red: 0.898, green: 0.898, blue: 0.914, alpha: 1) // #E5E5E9
    })

    static let controlSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.145, green: 0.145, blue: 0.157, alpha: 1) // #252528
            : UIColor(red: 0.882, green: 0.882, blue: 0.898, alpha: 1) // #E1E1E5
    })

    static let composerSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.169, green: 0.169, blue: 0.184, alpha: 1) // #2B2B2F
            : UIColor(red: 0.914, green: 0.914, blue: 0.929, alpha: 1) // #E9E9ED
    })

    static let card = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.115, green: 0.115, blue: 0.125, alpha: 1)
            : UIColor.secondarySystemBackground
    })
}
