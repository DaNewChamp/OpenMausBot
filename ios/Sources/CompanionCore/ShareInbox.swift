import Darwin
import Foundation

public enum ShareInboxError: Error, Equatable, Sendable, LocalizedError {
    case lockUnavailable

    public var errorDescription: String? {
        switch self {
        case .lockUnavailable:
            "Shared content is busy. Try again."
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

    private static let processLock = NSLock()

    #if DEBUG
    public static var testRootURL: URL?
    public static var testDefaultsSuite: String?
    public static var testForceLockUnavailable = false
    #endif

    public static func isValidImageFilename(_ name: String) -> Bool {
        guard !name.contains("/"), !name.contains("\\"), !name.contains("..") else { return false }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].lowercased() == "jpg" else { return false }
        return UUID(uuidString: String(parts[0])) != nil
    }

    public static func save(text: String? = nil, url: String? = nil, imageData: Data? = nil) throws {
        try withLock {
            let previous = peekPayload()
            var payload = Payload(text: text, url: url)
            if let imageData {
                let name = "\(UUID().uuidString).jpg"
                let file = containerURL().appendingPathComponent(name)
                try imageData.write(to: file, options: .atomic)
                payload.imageFilename = name
            }
            let data = try JSONEncoder().encode(payload)
            defaults().set(data, forKey: payloadKey)
            if let oldName = previous?.imageFilename, oldName != payload.imageFilename {
                removeImageFileIfValid(oldName)
            }
        }
    }

    public static func consume() throws -> (payload: Payload, imageData: Data?)? {
        try withLock {
            guard let data = defaults().data(forKey: payloadKey),
                  let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
            defaults().removeObject(forKey: payloadKey)
            var imageData: Data?
            if let name = payload.imageFilename, isValidImageFilename(name) {
                let file = containerURL().appendingPathComponent(name)
                imageData = try? Data(contentsOf: file)
                try? FileManager.default.removeItem(at: file)
            }
            return (payload, imageData)
        }
    }

    public static func clearPending() throws {
        try withLock {
            guard let data = defaults().data(forKey: payloadKey),
                  let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
                defaults().removeObject(forKey: payloadKey)
                return
            }
            defaults().removeObject(forKey: payloadKey)
            if let name = payload.imageFilename {
                removeImageFileIfValid(name)
            }
        }
    }

    public static func hasPending() throws -> Bool {
        try withLock {
            defaults().data(forKey: payloadKey) != nil
        }
    }

    private static func peekPayload() -> Payload? {
        guard let data = defaults().data(forKey: payloadKey) else { return nil }
        return try? JSONDecoder().decode(Payload.self, from: data)
    }

    private static func removeImageFileIfValid(_ name: String) {
        guard isValidImageFilename(name) else { return }
        try? FileManager.default.removeItem(at: containerURL().appendingPathComponent(name))
    }

    private static func withLock<T>(_ body: () throws -> T) throws -> T {
        processLock.lock()
        defer { processLock.unlock() }
        #if DEBUG
        if testForceLockUnavailable {
            throw ShareInboxError.lockUnavailable
        }
        #endif
        let lockURL = containerURL().appendingPathComponent(".share-inbox.lock")
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
        return try body()
    }

    private static func defaults() -> UserDefaults {
        #if DEBUG
        if let suite = testDefaultsSuite, let defaults = UserDefaults(suiteName: suite) {
            return defaults
        }
        #endif
        return UserDefaults(suiteName: appGroup)!
    }

    public static func containerURL() -> URL {
        #if DEBUG
        if let testRootURL {
            try? FileManager.default.createDirectory(at: testRootURL, withIntermediateDirectories: true)
            return testRootURL
        }
        #endif
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)!
    }
}
