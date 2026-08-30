import Foundation

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

    private static let lock = NSLock()

    #if DEBUG
    public static var testRootURL: URL?
    public static var testDefaultsSuite: String?
    #endif

    public static func save(text: String? = nil, url: String? = nil, imageData: Data? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        var payload = Payload(text: text, url: url)
        if let imageData {
            let name = "\(UUID().uuidString).jpg"
            let file = containerURL().appendingPathComponent(name)
            try imageData.write(to: file, options: .atomic)
            payload.imageFilename = name
        }
        let data = try JSONEncoder().encode(payload)
        defaults().set(data, forKey: payloadKey)
    }

    public static func consume() -> (payload: Payload, imageData: Data?)? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = defaults().data(forKey: payloadKey),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
        defaults().removeObject(forKey: payloadKey)
        var imageData: Data?
        if let name = payload.imageFilename {
            let file = containerURL().appendingPathComponent(name)
            imageData = try? Data(contentsOf: file)
            try? FileManager.default.removeItem(at: file)
        }
        return (payload, imageData)
    }

    public static func clearPending() {
        lock.lock()
        defer { lock.unlock() }
        guard let data = defaults().data(forKey: payloadKey),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            defaults().removeObject(forKey: payloadKey)
            return
        }
        defaults().removeObject(forKey: payloadKey)
        if let name = payload.imageFilename {
            try? FileManager.default.removeItem(at: containerURL().appendingPathComponent(name))
        }
    }

    public static func hasPending() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return defaults().data(forKey: payloadKey) != nil
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
