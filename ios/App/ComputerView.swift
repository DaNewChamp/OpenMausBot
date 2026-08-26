// A bot's computer, live.
//
// The phone is a watch surface first. It can open the secure Box viewer when
// the paired computer says that capability is available, but it never turns
// VPS, Local VM, or local-host previews into pretend touch controls.
import SwiftUI
import CompanionCore
import UIKit

struct ComputerView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingDesktop = false
    @State private var openingDesktop = false
    @State private var desktopURL: URL?
    @State private var desktopError: String?
    @State private var screenLoadFailure: String?

    private var frame: ScreenFrame? { session.state.screens[bot.id] }

    /// The bot as the stream last described it — `busy` is what tells us
    /// whether more frames are coming or this is the last one.
    private var current: Bot { session.state.bot(bot.id) ?? bot }

    private var image: UIImage? {
        frame?.data.flatMap(UIImage.init(data:))
    }

    private var presentationState: ComputerPresentationState {
        if image != nil { return .watching }
        let failure = frame == nil ? screenLoadFailure : "The latest screen frame could not be decoded."
        return ComputerPresentationState.resolve(bot: current, loadFailure: failure)
    }

    private var canOpenCloudViewer: Bool {
        ComputerPresentationState.supportsCloudViewer(current)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                content
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .background {
            InteractivePopGestureEnabler()
                .frame(width: 0, height: 0)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: presentationState)
        .safeAreaInset(edge: .bottom) {
            if canOpenCloudViewer {
                cloudViewerFooter
            }
        }
        .alert("Open live cloud desktop?", isPresented: $confirmingDesktop) {
            Button("Cancel", role: .cancel) {}
            Button("Open desktop") { Task { await openDesktop() } }
        } message: {
            Text("This gives this phone full control of the cloud computer, including anything signed in inside it.")
        }
        .sheet(
            isPresented: Binding(
                get: { desktopURL != nil },
                set: { if !$0 { desktopURL = nil } }
            )
        ) {
            if let desktopURL {
                CloudDesktopBrowser(url: desktopURL)
                    .ignoresSafeArea()
            }
        }
        .onAppear {
            session.watchScreen(of: bot.id)
        }
        .onDisappear {
            session.stopWatchingScreen(of: bot.id)
        }
        .onChange(of: frame?.png) { _, png in
            if png != nil { screenLoadFailure = nil }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel("Back")

            BotAvatarView(bot: current, size: 30, state: .idle, animated: false)

            VStack(alignment: .leading, spacing: 1) {
                Text(current.name)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                Text("Computer")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }

            Spacer(minLength: 8)

            Text(current.busy == true ? "Live" : "Idle")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(current.busy == true ? Color.green : Color.secondary)
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("\(current.name)'s computer")
        } else {
            stateCard
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var stateCard: some View {
        switch presentationState {
        case .starting:
            VStack(spacing: 14) {
                ProgressView()
                    .tint(.white)
                    .controlSize(.regular)
                Text("Starting computer…")
                    .font(.system(size: 17, weight: .semibold))
                Text(startingMessage)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.white.opacity(0.65))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            .foregroundStyle(Color.white)

        case .cloudViewerAvailable:
            VStack(spacing: 14) {
                Image(systemName: "display.and.arrow.down")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                Text("Cloud desktop ready")
                    .font(.system(size: 17, weight: .semibold))
                Text("Live preview will appear while the agent works. You can also open a secure viewer below.")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.white.opacity(0.65))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }
            .foregroundStyle(Color.white)

        case let .unavailable(message):
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Color.orange)
                Text("Computer unavailable")
                    .font(.system(size: 17, weight: .semibold))
                Text(message)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.white.opacity(0.65))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button("Try again", action: retryScreen)
                    .buttonStyle(.borderedProminent)
            }
            .foregroundStyle(Color.white)

        case .watching:
            EmptyView()
        }
    }

    private var startingMessage: String {
        if current.cloudBackend == "vps" || current.computer == "vm" || current.computer == "local" {
            return "This phone can watch frames while the agent works. Control stays on the computer."
        }
        if current.busy == true {
            return "Waiting for the first frame…"
        }
        return "This bot's computer is captured while it is working."
    }

    private var cloudViewerFooter: some View {
        VStack(spacing: 8) {
            if let desktopError {
                Text(desktopError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button {
                confirmingDesktop = true
            } label: {
                if openingDesktop {
                    ProgressView()
                        .tint(.white)
                        .frame(maxWidth: .infinity)
                } else {
                    Label("Open secure cloud viewer", systemImage: "display")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(openingDesktop)
            Text("The viewer is temporary and protected by this phone's pairing.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.6))
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }

    private func retryScreen() {
        screenLoadFailure = nil
        session.stopWatchingScreen(of: bot.id)
        session.watchScreen(of: bot.id)
    }

    @MainActor
    private func openDesktop() async {
        openingDesktop = true
        desktopError = nil
        defer { openingDesktop = false }
        do {
            desktopURL = try await session.cloudDesktop(for: current)
        } catch {
            desktopError = error.localizedDescription
        }
    }
}
