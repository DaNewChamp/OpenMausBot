import SwiftUI
import UIKit
import CompanionCore

/// The phone owner's local identity. It is deliberately separate from a
/// computer avatar: pairing names describe machines, not the person using V Bot.
struct AccountAvatar: View {
    @AppStorage(PrefKey.accountAvatarSymbol) private var storedSymbol = AccountAvatarSymbol.person.rawValue
    @AppStorage(AccountAvatarPhotoStore.revisionDefaultsKey) private var photoRevision = 0
    var size: CGFloat = 34

    var body: some View {
        Group {
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
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
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var photo: UIImage? {
        _ = photoRevision
        guard let data = AccountAvatarPhotoStore.loadPhoto() else { return nil }
        return UIImage(data: data)
    }
}
