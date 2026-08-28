import Social
import UIKit
import UniformTypeIdentifiers

/// Receives Share-sheet content, writes it to the app group, and opens V Bot.
final class ShareViewController: SLComposeServiceViewController {
    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        defer { extensionContext?.completeRequest(returningItems: nil) }
        var text = contentText?.trimmingCharacters(in: .whitespacesAndNewlines)
        var url: String?
        var imageData: Data?
        let group = DispatchGroup()

        for item in extensionContext?.inputItems ?? [] {
            guard let input = item as? NSExtensionItem else { continue }
            for provider in input.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier) { item, _ in
                        defer { group.leave() }
                        if let image = item as? UIImage, let data = image.jpegData(compressionQuality: 0.92) {
                            imageData = data
                        } else if let url = item as? URL, let data = try? Data(contentsOf: url) {
                            imageData = data
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
                        defer { group.leave() }
                        if let shareURL = item as? URL { url = shareURL.absoluteString }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
                        defer { group.leave() }
                        if let piece = item as? String, !piece.isEmpty {
                            text = [text, piece].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: "\n")
                        }
                    }
                }
            }
        }

        group.notify(queue: .main) {
            try? ShareInbox.save(text: text, url: url, imageData: imageData)
            if let open = URL(string: "openmausbot://share") {
                self.extensionContext?.open(open, completionHandler: nil)
            }
        }
    }
}
