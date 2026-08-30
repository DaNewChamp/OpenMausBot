import Foundation
import UIKit
import UserNotifications
import CompanionCore
import UniformTypeIdentifiers

/// The on-device notification surface. Delivery comes from live or replayed
/// companion frames; a future APNs relay can feed the same categories and
/// userInfo without changing the rest of the app. See `PushRegistrationScaffold`
/// and `docs/ios-push-apns.md` for the closed-app path (not enabled).
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    private let center = UNUserNotificationCenter.current()
    /// Set by `Session`; kept as an id-only value so the notification layer
    /// does not know about SwiftUI navigation or mutable fleet state.
    var responseHandler: ((NotificationTarget) -> Void)?
    /// The thread the user is actively reading. While the app is foreground,
    /// matching alerts are suppressed — the chat is already on screen.
    var foregroundThreadId: String?
    var appIsActive = false

    private override init() {
        super.init()
        center.delegate = self
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
    }

    func deliver(_ notification: NotificationFrame, sequence: Int?, avatarPNG: Data?) {
        if shouldSuppress(threadId: notification.threadId) { return }
        var content = UNMutableNotificationContent()
        content.title = notification.botName.isEmpty ? notification.title : notification.botName
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = notification.isBlocking ? "OPENMAUS_APPROVAL" : "OPENMAUS_UPDATE"
        content.threadIdentifier = notification.threadId
        content.userInfo = [
            "threadId": notification.threadId,
            "botId": notification.botId,
            "kind": notification.kind,
        ]
        if notification.isBlocking { content.interruptionLevel = .timeSensitive }

        // Keep the bot face as a trailing attachment. Do not wrap this in
        // INSendMessageIntent: that is a Communication Notification, and the
        // App ID does not have that entitlement. iOS then stamps Apple's
        // generic communication placeholder (the dark square with a white
        // A) on the leading edge instead of V Bot's mark.
        if let avatarPNG, let attachment = Self.avatarAttachment(png: avatarPNG) {
            content.attachments = [attachment]
        }

        // A replay after a short disconnect must reconcile a missed alert,
        // but a repeated frame must not draw it twice.
        let identifier = "openmaus.\(notification.threadId).\(sequence.map(String.init) ?? notification.title)"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    func setBadge(_ count: Int) {
        center.setBadgeCount(max(0, count))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let threadId = notification.request.content.userInfo["threadId"] as? String
        if let threadId, shouldSuppress(threadId: threadId) {
            completionHandler([])
            return
        }
        completionHandler([.banner, .list, .sound, .badge])
    }

    private func shouldSuppress(threadId: String) -> Bool {
        appIsActive && foregroundThreadId == threadId
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let strings = response.notification.request.content.userInfo.reduce(into: [String: String]()) { result, pair in
            guard let key = pair.key as? String, let value = pair.value as? String else { return }
            result[key] = value
        }
        if let target = NotificationTarget(payload: strings) { responseHandler?(target) }
        completionHandler()
    }

    private static func avatarAttachment(png: Data) -> UNNotificationAttachment? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vbot-note-\(UUID().uuidString).png")
        do {
            try png.write(to: url, options: .atomic)
            return try UNNotificationAttachment(
                identifier: "avatar",
                url: url,
                options: [UNNotificationAttachmentOptionsTypeHintKey: UTType.png.identifier]
            )
        } catch {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }
}

enum NotificationAvatar {
    static func circularPNG(from image: UIImage, size: CGFloat = 96) -> Data? {
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        format.scale = 3
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format)
        let drawn = renderer.image { _ in
            UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: size, height: size)).addClip()
            let scale = max(size / image.size.width, size / image.size.height)
            let drawSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let origin = CGPoint(x: (size - drawSize.width) / 2, y: (size - drawSize.height) / 2)
            image.draw(in: CGRect(origin: origin, size: drawSize))
        }
        return drawn.pngData()
    }
}
