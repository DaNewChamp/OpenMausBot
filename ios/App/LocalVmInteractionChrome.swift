import SwiftUI

/// Grok-style floating clipboard + keyboard controls for a Local VM session.
struct LocalVmInteractionChrome: View {
    var canPaste: Bool
    var canCopy: Bool
    var keyboardActive: Bool
    let onPasteFromPhone: () -> Void
    let onCopyToPhone: () -> Void
    let onToggleKeyboard: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                chromeButton(title: "Paste from iPhone", systemImage: "doc.on.clipboard", action: onPasteFromPhone)
                    .disabled(!canPaste)
                Divider().opacity(0.25)
                chromeButton(title: "Copy to iPhone", systemImage: "clipboard", action: onCopyToPhone)
                    .disabled(!canCopy)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: 220, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
            }

            Spacer(minLength: 0)

            Button(action: onToggleKeyboard) {
                Image(systemName: keyboardActive ? "keyboard.chevron.compact.down" : "keyboard")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 52, height: 52)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(keyboardActive ? "Hide keyboard" : "Show keyboard")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(Color.black.opacity(0.92))
    }

    private func chromeButton(title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 22)
                Text(title)
                    .font(.subheadline.weight(.medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
