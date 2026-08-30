import SwiftUI

/// Floating clipboard, screenshot save, and keyboard controls for a Local VM
/// session. The keyboard button stays pinned bottom-right; paste/copy/save
/// live in a card that opens from the clipboard button.
struct LocalVmInteractionChrome: View {
    var canPaste: Bool
    var canCopy: Bool
    var canSave: Bool = false
    var canType: Bool
    var keyboardActive: Bool
    @Binding var pointerMode: VmPointerMode
    let onPasteFromPhone: () -> Void
    let onCopyToPhone: () -> Void
    var onSaveScreenshot: (() -> Void)? = nil
    let onToggleKeyboard: () -> Void

    @State private var clipboardExpanded = false

    var body: some View {
        VStack(spacing: 10) {
            pointerModeToggle
            HStack(alignment: .bottom, spacing: 12) {
                if clipboardExpanded {
                    clipboardCard
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }

                Spacer(minLength: 0)

                chromeIconButton(
                    systemImage: "doc.on.clipboard",
                    accessibilityLabel: clipboardExpanded ? "Hide clipboard" : "Show clipboard",
                    action: { clipboardExpanded.toggle() }
                )

                chromeIconButton(
                    systemImage: keyboardActive ? "keyboard.chevron.compact.down" : "keyboard",
                    accessibilityLabel: keyboardActive ? "Hide keyboard" : "Show keyboard",
                    action: onToggleKeyboard
                )
                .disabled(!canType)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: clipboardExpanded)
        .animation(.easeInOut(duration: 0.2), value: pointerMode)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private var pointerModeToggle: some View {
        HStack(spacing: 8) {
            ForEach(VmPointerMode.allCases) { mode in
                Button {
                    pointerMode = mode
                    Haptics.selection()
                } label: {
                    Label(mode.title, systemImage: mode.systemImage)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(pointerMode == mode ? Color.primary : Color.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(
                            pointerMode == mode
                                ? Color.primary.opacity(0.12)
                                : Color.primary.opacity(0.05),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(mode.title) input mode")
                .accessibilityHint(mode.accessibilityHint)
                .accessibilityAddTraits(pointerMode == mode ? .isSelected : [])
            }
        }
        .padding(4)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pointer mode")
    }

    private var clipboardCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            chromeButton(title: "Paste from iPhone", systemImage: "doc.on.clipboard", action: onPasteFromPhone)
                .disabled(!canPaste || !canType)
            Divider().opacity(0.25)
            chromeButton(title: "Copy to iPhone", systemImage: "clipboard", action: onCopyToPhone)
                .disabled(!canCopy)
            if let onSaveScreenshot {
                Divider().opacity(0.25)
                chromeButton(title: "Save to Photos", systemImage: "square.and.arrow.down", action: onSaveScreenshot)
                    .disabled(!canSave)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: 220, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Clipboard controls")
    }

    private func chromeIconButton(
        systemImage: String,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
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
        .accessibilityLabel(accessibilityLabel)
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
