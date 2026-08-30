import SwiftUI
import AudioToolbox

#if canImport(UIKit)
import UIKit
public typealias PlatformColorType = UIColor
public typealias PlatformImage = UIImage
#elseif canImport(AppKit)
import AppKit
public typealias PlatformColorType = NSColor
public typealias PlatformImage = NSImage
#endif

// MARK: - Preferences
public enum CompanionPreferences {
    public static let hapticsKey = "companion.hapticsEnabled"
    public static let soundsKey = "companion.soundsEnabled"

    public static var hapticsEnabled: Bool {
        UserDefaults.standard.object(forKey: hapticsKey) as? Bool ?? true
    }

    public static var soundsEnabled: Bool {
        UserDefaults.standard.object(forKey: soundsKey) as? Bool ?? true
    }
}

// MARK: - Sound Effects
public enum SoundEffects {
    public static func playSent() {
        #if os(iOS)
        guard CompanionPreferences.soundsEnabled else { return }
        AudioServicesPlaySystemSound(1004)
        #endif
    }

    public static func playReceived() {
        #if os(iOS)
        guard CompanionPreferences.soundsEnabled else { return }
        AudioServicesPlaySystemSound(1003)
        #endif
    }

    public static func playTapback() {
        #if os(iOS)
        guard CompanionPreferences.soundsEnabled else { return }
        AudioServicesPlaySystemSound(1104)
        #endif
    }

    public static func playActionSuccess() {
        #if os(iOS)
        guard CompanionPreferences.soundsEnabled else { return }
        AudioServicesPlaySystemSound(1025)
        #endif
    }

    public static func playCelebration() {
        #if os(iOS)
        guard CompanionPreferences.soundsEnabled else { return }
        AudioServicesPlaySystemSound(1028)
        #endif
    }

    public static func playConnect() {
        #if os(iOS)
        guard CompanionPreferences.soundsEnabled else { return }
        AudioServicesPlaySystemSound(1109)
        #endif
    }
}

// MARK: - Haptic Feedback
public enum Haptics {
    public static func selection() {
        #if os(iOS)
        guard CompanionPreferences.hapticsEnabled else { return }
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
        #endif
    }

    public static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        #if os(iOS)
        guard CompanionPreferences.hapticsEnabled else { return }
        let generator = UIImpactFeedbackGenerator(style: clamped(style))
        generator.prepare()
        generator.impactOccurred()
        #endif
    }

    /// Soft tap for chrome and shelf changes. Never a heavy impact.
    public static func soft() {
        #if os(iOS)
        impact(.soft)
        #endif
    }

    private static func clamped(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator.FeedbackStyle {
        switch style {
        case .heavy, .rigid: return .medium
        default: return style
        }
    }

    public static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        #if os(iOS)
        guard CompanionPreferences.hapticsEnabled else { return }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(type)
        #endif
    }

    public static func success() {
        notification(.success)
    }

    public static func warning() {
        notification(.warning)
    }

    public static func error() {
        notification(.error)
    }
}

// MARK: - Platform Bridge
public enum PlatformBridge {
    public static func copyToPasteboard(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #elseif os(macOS)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        #endif
        Haptics.selection()
    }
}

// MARK: - Color Utilities & Semantic Palettes
public extension Color {
    static var platformBackground: Color {
        #if os(iOS)
        return Color(uiColor: .systemBackground)
        #elseif os(macOS)
        return Color(nsColor: .windowBackgroundColor)
        #endif
    }

    static var platformSecondaryBackground: Color {
        #if os(iOS)
        return Color(uiColor: .secondarySystemBackground)
        #elseif os(macOS)
        return Color(nsColor: .controlBackgroundColor)
        #endif
    }

    static var platformTertiaryBackground: Color {
        #if os(iOS)
        return Color(uiColor: .tertiarySystemBackground)
        #elseif os(macOS)
        return Color(nsColor: .underPageBackgroundColor)
        #endif
    }

    static var platformSeparator: Color {
        #if os(iOS)
        return Color(uiColor: .separator)
        #elseif os(macOS)
        return Color(nsColor: .separatorColor)
        #endif
    }
}
