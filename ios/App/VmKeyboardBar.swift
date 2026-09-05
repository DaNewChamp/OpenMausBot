import SwiftUI

/// Visible typing bar for Local VM keyboard input on iPhone.
struct VmKeyboardBar: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Type on VM…", text: $text, axis: .vertical)
                .lineLimit(1...4)
                .focused(isFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(VBotSurface.composerSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onSubmit(onSend)

            Button("Send", action: onSend)
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: VBotSurface.Hit.minimum)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("Done", action: onDismiss)
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: VBotSurface.Hit.minimum)
                .accessibilityLabel("Done")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(VBotSurface.card.opacity(0.96))
        .onAppear {
            DispatchQueue.main.async {
                isFocused.wrappedValue = true
            }
        }
    }
}
