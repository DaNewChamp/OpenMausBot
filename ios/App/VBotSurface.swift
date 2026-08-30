import SwiftUI
import UIKit
import CompanionCore

/// Shared near-black / paper canvas for home, chat, settings, and profiles.
/// Dark mode tracks the Grok Bot home canvas: charcoal near-black, not
/// pure black. Light mode keeps a quiet paper gray so contrast is not
/// invented twice per screen.
enum VBotSurface {
    static let background = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.071, green: 0.071, blue: 0.078, alpha: 1) // #121214
            : UIColor(red: 0.965, green: 0.965, blue: 0.973, alpha: 1) // #F6F6F8
    })

    static let assistantBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.125, green: 0.125, blue: 0.125, alpha: 1) // #202020
            : UIColor(red: 0.898, green: 0.898, blue: 0.914, alpha: 1) // #E5E5E9
    })

    static let controlSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1) // #1C1C1E
            : UIColor(red: 0.882, green: 0.882, blue: 0.898, alpha: 1) // #E1E1E5
    })

    static let composerSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.173, green: 0.173, blue: 0.180, alpha: 1) // #2C2C2E
            : UIColor(red: 0.914, green: 0.914, blue: 0.929, alpha: 1) // #E9E9ED
    })

    /// User bubbles on the Grok canvas: a lifted gray, never a brand fill.
    static let userBubble = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.173, green: 0.173, blue: 0.180, alpha: 1) // #2C2C2E
            : UIColor(red: 0.227, green: 0.243, blue: 0.275, alpha: 1) // #3A3E46
    })

    /// Roster unread mark. The reference uses system blue, not the bot color.
    static let unread = Color(uiColor: .systemBlue)

    static let card = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1)
            : UIColor.secondarySystemBackground
    })

    static let hairline = Color.primary.opacity(0.09)
    static let skeletonFill = Color.primary.opacity(0.07)
    static let routineIcon = Color.purple

    enum Radius {
        static let card: CGFloat = 20
        static let control: CGFloat = 14
        static let button: CGFloat = 16
        static let sheet: CGFloat = 28
        static let icon: CGFloat = 8
    }

    enum Space {
        static let page: CGFloat = 20
        static let section: CGFloat = 16
        static let row: CGFloat = 12
        static let chrome: CGFloat = 16
    }

    enum Hit {
        static let minimum: CGFloat = 44
        static let row: CGFloat = 56
    }
}

extension View {
    func vbotCanvas() -> some View {
        background(VBotSurface.background.ignoresSafeArea())
    }

    func vbotCard(radius: CGFloat = VBotSurface.Radius.card) -> some View {
        background(
            VBotSurface.card,
            in: RoundedRectangle(cornerRadius: radius, style: .continuous)
        )
    }

    func vbotControlSurface(radius: CGFloat = VBotSurface.Radius.control) -> some View {
        background(
            VBotSurface.controlSurface,
            in: RoundedRectangle(cornerRadius: radius, style: .continuous)
        )
    }

    func vbotGroupedChrome() -> some View {
        scrollContentBackground(.hidden)
            .background(VBotSurface.background.ignoresSafeArea())
    }

    func vbotRowSurface() -> some View {
        listRowBackground(VBotSurface.card)
            .listRowSeparatorTint(VBotSurface.hairline)
    }

    func vbotCardAnimation<V: Equatable>(reduceMotion: Bool, value: V) -> some View {
        animation(reduceMotion ? nil : .snappy(duration: 0.28), value: value)
    }
}

/// Grouped card used by Settings, profiles, and computer sheets so those
/// screens share home's graphite canvas instead of Form gray.
struct VBotSurfaceGroup<Content: View>: View {
    var title: String? = nil
    var footer: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 18)
            }
            VStack(spacing: 0, content: content)
                .vbotCard()
            if let footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 18)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct VBotHairline: View {
    var body: some View {
        Divider().overlay(VBotSurface.hairline)
    }
}

/// Calm placeholder bars. Pulse opacity only; Reduce Motion keeps them still.
struct CalmSkeletonBar: View {
    var width: CGFloat? = nil
    var height: CGFloat = 14
    var cornerRadius: CGFloat = 4

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(VBotSurface.skeletonFill)
            .frame(width: width, height: height)
            .opacity(reduceMotion ? 1 : (dimmed ? 0.55 : 1))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) {
                    dimmed = true
                }
            }
            .onChange(of: reduceMotion) { _, reduced in
                if reduced {
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        dimmed = false
                    }
                } else {
                    dimmed = false
                    withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) {
                        dimmed = true
                    }
                }
            }
            .accessibilityHidden(true)
    }
}

struct CalmSkeletonList: View {
    var rows: Int = 4
    var label: String = "Loading"

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    CalmSkeletonBar(width: 28, height: 28, cornerRadius: VBotSurface.Radius.icon)
                    CalmSkeletonBar(width: CGFloat(118 + index * 14), height: 13)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: VBotSurface.Hit.minimum, alignment: .leading)

                if index < rows - 1 {
                    VBotHairline().padding(.leading, 56)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

struct CalmDesktopSkeleton: View {
    var message: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 16) {
            RoundedRectangle(cornerRadius: VBotSurface.Radius.card, style: .continuous)
                .fill(VBotSurface.controlSurface)
                .overlay {
                    VStack(alignment: .leading, spacing: 10) {
                        CalmSkeletonBar(width: 120, height: 10)
                        CalmSkeletonBar(width: 180, height: 10)
                        CalmSkeletonBar(width: 96, height: 10)
                        Spacer(minLength: 0)
                    }
                    .padding(18)
                }
                .frame(maxWidth: 280, minHeight: 160, maxHeight: 200)
                .opacity(reduceMotion ? 1 : 0.92)

            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

struct ReconnectToEditBanner: View {
    var body: some View {
        Label(CalmSurfacePolicy.reconnectToEdit, systemImage: "icloud.slash")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.minimum)
            .vbotCard()
            .accessibilityLabel(CalmSurfacePolicy.reconnectToEdit)
    }
}

/// Slim graphite banner for transient Local VM status-poll failures on the
/// Computer screen. Sits under the header so it never covers the viewer.
struct LocalVmStatusErrorBannerView: View {
    let presentation: LocalVmStatusErrorBanner.Presentation
    var onRetry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Label(presentation.message, systemImage: "wifi.exclamationmark")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if presentation.showsRetry {
                Button(LocalVmStatusErrorBanner.retryTitle, action: onRetry)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.plain)
                    .frame(minHeight: VBotSurface.Hit.minimum)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .vbotControlSurface()
        .padding(.horizontal, VBotSurface.Space.page)
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview("Skeleton list") {
    CalmSkeletonList()
        .padding()
        .vbotCanvas()
}

#Preview("Reconnect banner") {
    ReconnectToEditBanner()
        .padding()
        .vbotCanvas()
}
#endif
