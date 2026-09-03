import Foundation

/// Phone-owner avatar photo. Bytes live in Application Support with
/// complete-until-first-unlock protection; UserDefaults only holds a
/// path-independent revision marker.
public enum AccountAvatarPhotoStore: Sendable {
    public static let revisionDefaultsKey = "companion.prefs.accountAvatarPhotoRevision"
    public static let fileName = "account-avatar.jpg"
    public static let directoryName = "AccountAvatar"
    public static let fileProtectionPolicy = FileProtectionPolicy.completeUntilFirstUserAuthentication

    public enum FileProtectionPolicy: Equatable, Sendable {
        case completeUntilFirstUserAuthentication
    }

    public struct Snapshot: Equatable, Sendable {
        public var revision: Int
        public var photo: Data?

        public init(revision: Int, photo: Data?) {
            self.revision = revision
            self.photo = photo
        }
    }

    #if DEBUG
    public static var testSupportDirectory: URL?
    public static var testDefaults: UserDefaults?
    #endif

    public static func revision() -> Int {
        defaults().integer(forKey: revisionDefaultsKey)
    }

    public static func photoURL() -> URL {
        supportDirectory().appendingPathComponent(fileName)
    }

    public static func isAvailable() -> Bool {
        loadPhoto() != nil
    }

    public static func loadPhoto() -> Data? {
        let url = photoURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url), isReadableJPEG(data) else { return nil }
        return data
    }

    public static func savePhoto(_ jpeg: Data) throws {
        guard isReadableJPEG(jpeg) else {
            throw AvatarCropExport.Failure.undecodable
        }
        let directory = supportDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = photoURL()
        let temporary = directory.appendingPathComponent("\(fileName).tmp")
        try jpeg.write(to: temporary, options: .atomic)
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
        applyFileProtection(at: destination)
        defaults().set(revision() + 1, forKey: revisionDefaultsKey)
    }

    public static func removePhoto() throws {
        let url = photoURL()
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        defaults().set(0, forKey: revisionDefaultsKey)
    }

    private static func isReadableJPEG(_ data: Data) -> Bool {
        guard AvatarCropExport.isJPEG(data), let inspection = AvatarCropExport.inspect(data) else {
            return false
        }
        return inspection.pixelSize.width > 0 && inspection.pixelSize.height > 0 && !inspection.isAnimated
    }

    private static func supportDirectory() -> URL {
        #if DEBUG
        if let testSupportDirectory { return testSupportDirectory }
        #endif
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(directoryName, isDirectory: true)
    }

    private static func defaults() -> UserDefaults {
        #if DEBUG
        if let testDefaults { return testDefaults }
        #endif
        return .standard
    }

    private static func applyFileProtection(at url: URL) {
        #if os(iOS)
        try? (url as NSURL).setResourceValue(
            URLFileProtection.completeUntilFirstUserAuthentication,
            forKey: .fileProtectionKey
        )
        #endif
    }
}
