import Foundation

/// Handoff from the share extension into the main app via the app group.
enum ShareInbox {
    static let appGroup = "group.com.posival.openmausmobile"
    static let payloadKey = "pendingSharePayload"

    struct Payload: Codable, Equatable {
        var text: String?
        var url: String?
        var imageFilename: String?
    }

    static func save(text: String? = nil, url: String? = nil, imageData: Data? = nil) throws {
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

    static func consume() -> (payload: Payload, imageData: Data?)? {
        guard let data = defaults().data(forKey: payloadKey),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
        defaults().removeObject(forKey: payloadKey)
        var imageData: Data?
        if let name = payload.imageFilename {
            imageData = try? Data(contentsOf: containerURL().appendingPathComponent(name))
            try? FileManager.default.removeItem(at: containerURL().appendingPathComponent(name))
        }
        return (payload, imageData)
    }

    private static func defaults() -> UserDefaults {
        UserDefaults(suiteName: appGroup)!
    }

    static func containerURL() -> URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)!
    }
}
