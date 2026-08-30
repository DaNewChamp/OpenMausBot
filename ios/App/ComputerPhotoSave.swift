import Photos
import UIKit
import CompanionCore

/// Add-only Photos save for the Computer screenshot. Read library access is
/// never requested here.
enum ComputerPhotoSave {
    static func save(_ image: UIImage) async -> PhotoLibrarySavePolicy.Outcome {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        let authorization = Self.authorization(status)
        if authorization != .authorized {
            return PhotoLibrarySavePolicy.outcome(authorization: authorization, saved: false)
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }
            return .saved
        } catch {
            return .failed
        }
    }

    private static func authorization(_ status: PHAuthorizationStatus) -> PhotoLibrarySavePolicy.Authorization {
        switch status {
        case .authorized, .limited: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .undetermined
        @unknown default: return .denied
        }
    }
}
