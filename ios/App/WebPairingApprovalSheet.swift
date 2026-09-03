import SwiftUI
import CompanionCore

struct WebPairingApprovalSheet: View {
    let request: WebPairingRequest
    let hubName: String
    let onApprove: () -> Void
    let onDeny: () -> Void
    @State private var submitting = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "desktopcomputer.and.arrow.down")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(MausPalette.color("blue"))
                    .accessibilityHidden(true)

                Text(WebPairingScanPolicy.confirmationTitle(deviceName: request.deviceName))
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)

                Text(WebPairingScanPolicy.confirmationMessage(deviceName: request.deviceName, hubName: hubName))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Text(request.hubOrigin)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 12) {
                    Button {
                        guard !submitting else { return }
                        submitting = true
                        onApprove()
                    } label: {
                        Text("Approve")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(submitting)

                    Button("Don't allow", role: .cancel, action: onDeny)
                        .disabled(submitting)
                }
                .padding(20)
            }
            .navigationTitle("Approve browser")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDeny)
                        .disabled(submitting)
                }
            }
        }
    }
}
