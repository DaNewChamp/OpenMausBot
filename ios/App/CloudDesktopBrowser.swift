// The cloud provider's noVNC viewer, kept inside the app without teaching
// OpenMausMobile how to speak VNC or retain the provider's session token.
// SFSafariViewController supplies a hardened browser, WebSocket support and
// its own visible origin; dismissing it discards our only reference to the
// freshly minted URL.
import CompanionCore
import SafariServices
import SwiftUI

struct CloudDesktopBrowser: View {
    let url: URL

    private var origin: String {
        CloudViewerPolicy.sanitizedOrigin(for: url) ?? CloudViewerPolicy.originUnavailable
    }

    var body: some View {
        VStack(spacing: 0) {
            originChrome
            CloudDesktopSafari(url: url)
                .ignoresSafeArea(edges: .bottom)
        }
        .background(VBotSurface.background)
    }

    private var originChrome: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(origin)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.primary)
                .lineLimit(1)
            Text(CloudViewerPolicy.externalSemantics)
                .font(.caption2)
                .foregroundStyle(Color.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, VBotSurface.Space.chrome)
        .frame(minHeight: VBotSurface.Hit.minimum)
        .background(VBotSurface.background.opacity(0.96))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(CloudViewerPolicy.originAccessibilityLabel(for: url))
        .accessibilityValue(CloudViewerPolicy.externalSemantics)
    }
}

private struct CloudDesktopSafari: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        configuration.barCollapsingEnabled = true
        let browser = SFSafariViewController(url: url, configuration: configuration)
        browser.dismissButtonStyle = .close
        browser.preferredControlTintColor = .systemBlue
        return browser
    }

    func updateUIViewController(_ browser: SFSafariViewController, context: Context) {}
}
