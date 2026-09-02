import SwiftUI
import CompanionCore

/// Optional post-pair Hermes offer on the chat roster. Dismiss persists per
/// computer and never blocks ordinary V Bot navigation.
struct HermesConnectionCard: View {
    let presentation: HermesConnectionCardPresentation
    let connecting: Bool
    let onConnect: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VBotSurfaceGroup {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.mint)
                        .frame(width: 34, height: 34)
                        .background(Color.mint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(presentation.title)
                            .font(.headline)
                        Text(presentation.message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }

                if let detail = presentation.detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }

                HStack(spacing: 10) {
                    Button(presentation.primaryActionTitle, action: onConnect)
                        .buttonStyle(.borderedProminent)
                        .disabled(connecting)
                    Button("Not now", action: onDismiss)
                        .foregroundStyle(.secondary)
                        .disabled(connecting)
                    if connecting {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }
            .padding(16)
        }
        .padding(.horizontal, HomeRosterLayoutPolicy.pagePadding)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}
