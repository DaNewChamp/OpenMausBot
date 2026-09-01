import SwiftUI
import CompanionCore

/// The phone owner's local identity. It is deliberately separate from a
/// computer avatar: pairing names describe machines, not the person using V Bot.
struct AccountAvatar: View {
    @AppStorage(PrefKey.accountAvatarSymbol) private var storedSymbol = AccountAvatarSymbol.person.rawValue
    var size: CGFloat = 34

    var body: some View {
        Circle()
            .fill(MausPalette.color("green"))
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: AccountAvatarSymbol.normalized(storedSymbol))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }
}
