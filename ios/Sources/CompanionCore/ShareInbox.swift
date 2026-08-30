import Darwin
import Foundation

public enum ShareInboxError: Error, Equatable, Sendable, LocalizedError {
    case lockUnavailable
    case appGroupUnavailable

    public var errorDescription: String? {
        switch self {
        case .lockUnavailable:
            "Shared content is busy. Try again."
        case .appGroupUnavailable:
            "Couldn't save shared content. Try again."
        }
    }
}

/// Handoff from the share extension into the main app via the app group.
public enum ShareInbox {
    public static let appGroup = "group.com.posival.openmausmobile"
    public static let payloadKey = "pendingSharePayload"

    public struct Payload: Codable, Equatable, Sendable {
        public var text: String?
        public var url: String?
        public var imageFilename: String?

        public init(text: String? = nil, url: String? = nil, imageFilename: String? = nil) {
            self.text = text
            self.url = url
            self.imageFilename = imageFilename
        }
    }

    private struct Storage {
        var directory: URL
        var defaults: UserDefaults
    }

    private static let processLock = NSLock()

    #if DEBUG
    public static var testRootURL: URL?
    public static var testDefaultsSuite: String?
    public static var testForceLockUnavailable = false
    public static var testAppGroupAvailable: Bool?
    public static var testStorePreviewActive: Bool?
    public static var testStorePreviewRootURL: URL?
    public static var testStorePreviewDefaultsSuite: String?
    #endif

    public static func isValidImageFilename(_ name: String) -> Bool {
        guard !name.contains("/"), !name.contains("\\"), !name.contains("..") else { return false }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].lowercased() == "jpg" else { return false }
        return UUID(uuidString: String(parts[0])) != nil
    }

    public static func save(text: String? = nil, url: String? = nil, imageData: Data? = nil) throws {
        try withLock { storage in
            let previous = peekPayload(storage)
            var payload = Payload(text: text, url: url)
            if let imageData {
                let name = "\(UUID().uuidString).jpg"
                let file = storage.directory.appendingPathComponent(name)
                try imageData.write(to: file, options: .atomic)
                payload.imageFilename = name
            }
            let data = try JSONEncoder().encode(payload)
            storage.defaults.set(data, forKey: payloadKey)
            if let oldName = previous?.imageFilename, oldName != payload.imageFilename {
                removeImageFileIfValid(oldName, in: storage)
            }
        }
    }

    public static func consume() throws -> (payload: Payload, imageData: Data?)? {
        try withLock { storage in
            guard let data = storage.defaults.data(forKey: payloadKey),
                  let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
            storage.defaults.removeObject(forKey: payloadKey)
            var imageData: Data?
            if let name = payload.imageFilename, isValidImageFilename(name) {
                let file = storage.directory.appendingPathComponent(name)
                imageData = try? Data(contentsOf: file)
                try? FileManager.default.removeItem(at: file)
            }
            return (payload, imageData)
        }
    }

    public static func clearPending() throws {
        try withLock { storage in
            guard let data = storage.defaults.data(forKey: payloadKey),
                  let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
                storage.defaults.removeObject(forKey: payloadKey)
                return
            }
            storage.defaults.removeObject(forKey: payloadKey)
            if let name = payload.imageFilename {
                removeImageFileIfValid(name, in: storage)
            }
        }
    }

    public static func hasPending() throws -> Bool {
        try withLock { storage in
            storage.defaults.data(forKey: payloadKey) != nil
        }
    }

    private static func peekPayload(_ storage: Storage) -> Payload? {
        guard let data = storage.defaults.data(forKey: payloadKey) else { return nil }
        return try? JSONDecoder().decode(Payload.self, from: data)
    }

    private static func removeImageFileIfValid(_ name: String, in storage: Storage) {
        guard isValidImageFilename(name) else { return }
        try? FileManager.default.removeItem(at: storage.directory.appendingPathComponent(name))
    }

    private static func withLock<T>(_ body: (Storage) throws -> T) throws -> T {
        processLock.lock()
        defer { processLock.unlock() }
        #if DEBUG
        if testForceLockUnavailable {
            throw ShareInboxError.lockUnavailable
        }
        #endif
        let storage = try resolvedStorage()
        let lockURL = storage.directory.appendingPathComponent(".share-inbox.lock")
        if !FileManager.default.fileExists(atPath: lockURL.path) {
            FileManager.default.createFile(
                atPath: lockURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        }
        let fd = open(lockURL.path, O_RDWR)
        guard fd >= 0 else {
            throw ShareInboxError.lockUnavailable
        }
        defer {
            flock(fd, LOCK_UN)
            close(fd)
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            throw ShareInboxError.lockUnavailable
        }
        return try body(storage)
    }

    private static func resolvedStorage() throws -> Storage {
        #if DEBUG
        if let testRootURL {
            try FileManager.default.createDirectory(at: testRootURL, withIntermediateDirectories: true)
            guard let suite = testDefaultsSuite, let defaults = UserDefaults(suiteName: suite) else {
                throw ShareInboxError.appGroupUnavailable
            }
            return Storage(directory: testRootURL, defaults: defaults)
        }
        #endif

        let appGroupURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        )
        #if DEBUG
        let appGroupAvailable = testAppGroupAvailable ?? (appGroupURL != nil)
        let storePreviewActive = testStorePreviewActive
            ?? ProcessInfo.processInfo.arguments.contains("-store-preview")
        let debugBuild = true
        #else
        let appGroupAvailable = appGroupURL != nil
        let storePreviewActive = false
        let debugBuild = false
        #endif

        switch ShareInboxContainerPolicy.resolution(
            appGroupAvailable: appGroupAvailable,
            storePreviewActive: storePreviewActive,
            debugBuild: debugBuild
        ) {
        case .appGroup:
            guard let appGroupURL,
                  let defaults = UserDefaults(suiteName: appGroup) else {
                throw ShareInboxError.appGroupUnavailable
            }
            return Storage(directory: appGroupURL, defaults: defaults)
        case .storePreviewInbox:
            #if DEBUG
            return try previewStorage()
            #else
            throw ShareInboxError.appGroupUnavailable
            #endif
        case .unavailable:
            throw ShareInboxError.appGroupUnavailable
        }
    }

    #if DEBUG
    private static func previewStorage() throws -> Storage {
        let root: URL
        if let testStorePreviewRootURL {
            root = testStorePreviewRootURL
        } else if let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first {
            root = ShareInboxContainerPolicy.previewInboxURL(applicationSupport: support)
        } else {
            throw ShareInboxError.appGroupUnavailable
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let suite = testStorePreviewDefaultsSuite ?? ShareInboxContainerPolicy.previewDefaultsSuite
        guard let defaults = UserDefaults(suiteName: suite) else {
            throw ShareInboxError.appGroupUnavailable
        }
        return Storage(directory: root, defaults: defaults)
    }
    #endif
}
