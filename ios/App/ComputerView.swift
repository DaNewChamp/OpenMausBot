// A bot's computer, live.
//
// The phone is a watch surface first. It can open the secure Box viewer when
// the paired computer says that capability is available, but it never turns
// VPS, Local VM, or local-host previews into pretend touch controls.
import SwiftUI
import CompanionCore
import UIKit

private extension LocalVmAction {
    var buttonTitle: String {
        switch self {
        case .create: return "Create"
        case .stop: return "Stop"
        case .recreate: return "Recreate"
        }
    }

    var systemImage: String {
        switch self {
        case .create: return "plus.circle"
        case .stop: return "stop.circle"
        case .recreate: return "arrow.clockwise.circle"
        }
    }

    var confirmationTitle: String {
        switch self {
        case .create: return "Create Local VM?"
        case .stop: return "Stop Local VM?"
        case .recreate: return "Recreate Local VM?"
        }
    }

    var confirmationMessage: String {
        switch self {
        case .create:
            return "This creates an isolated desktop on the paired Mac. Your durable workspace stays on that Mac."
        case .stop:
            return "This stops the disposable desktop. Your durable workspace stays on the paired Mac."
        case .recreate:
            return "This replaces the disposable desktop while preserving its durable workspace. It is only allowed when the bot is idle."
        }
    }
}

struct ComputerView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingDesktop = false
    @State private var openingDesktop = false
    @State private var desktopURL: URL?
    @State private var desktopError: String?
    @State private var screenWatch = ComputerWatchLifecycle()
    @State private var isWatchingScreen = false
    @State private var confirmingLocalVmAction: LocalVmAction?
    @State private var localVmError: String?

    private static let firstFrameTimeout = ComputerWatchLifecycle.firstFrameTimeout

    private var frame: ScreenFrame? { session.state.screens[bot.id] }

    /// The bot as the stream last described it — `busy` is what tells us
    /// whether more frames are coming or this is the last one.
    private var current: Bot { session.state.bot(bot.id) ?? bot }

    private var image: UIImage? {
        frame?.data.flatMap(UIImage.init(data:))
    }

    private var presentationState: ComputerPresentationState {
        let decodeFailure = ComputerPresentationState.hasKnownComputer(current)
            && current.busy == true
            && frame != nil
            && image == nil
            ? "The latest screen frame could not be decoded."
            : nil
        return ComputerPresentationState.resolve(
            bot: current,
            frame: image == nil ? nil : frame,
            loadFailure: streamFailure ?? screenWatch.failureMessage ?? decodeFailure
        )
    }

    private var canOpenCloudViewer: Bool {
        ComputerPresentationState.supportsCloudViewer(current)
            && !isUnavailable(presentationState)
    }

    private var localVmStatus: LocalVmStatus? {
        session.localVmStatus(for: current)
    }

    private var canShowLocalVmControls: Bool {
        ComputerPresentationState.supportsLocalVmControls(
            current,
            status: localVmStatus,
            accessGranted: session.localVmAccess
        )
    }

    private var pendingLocalVmAction: Bool {
        session.pendingLocalVmActions.contains(current.id)
    }

    private var streamFailure: String? {
        switch session.status {
        case let .offline(message): return message
        case .unauthorized: return "This phone is no longer paired with the computer."
        case .unpaired: return "Pair this phone with a computer to watch the screen."
        case .connecting, .live: return nil
        }
    }

    private var canRetryScreen: Bool {
        ComputerPresentationState.hasKnownComputer(current)
            && (screenWatch.failureMessage != nil || streamFailure != nil)
    }

    private func isUnavailable(_ state: ComputerPresentationState) -> Bool {
        if case .unavailable = state { return true }
        return false
    }

    private var computerSignature: String {
        let computer = current.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "auto"
        let backend = current.cloudBackend?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "legacy"
        return "\(computer)|\(backend)"
    }

    private var headerStatusTitle: String {
        switch presentationState {
        case .watching: return "Watching"
        case .starting: return "Working"
        case .cloudViewerAvailable: return "Ready"
        case .unavailable: return "Unavailable"
        }
    }

    private var headerStatusColor: Color {
        switch presentationState {
        case .watching: return .green
        case .starting: return .orange
        case .cloudViewerAvailable, .unavailable: return .secondary
        }
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
            } else if canShowLocalVmControls {
                localVmFooter
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
        .alert(item: $confirmingLocalVmAction) { action in
            Alert(
                title: Text(action.confirmationTitle),
                message: Text(action.confirmationMessage),
                primaryButton: .default(Text(action.buttonTitle)) {
                    Task { await runLocalVmAction(action) }
                },
                secondaryButton: .cancel()
            )
        }
        .onAppear {
            syncScreenWatch(resetFrame: false)
        }
        .onDisappear {
            stopScreenWatch()
        }
        .onChange(of: frame?.png) { _, png in
            guard let png else { return }
            let next = ScreenFrame(png: png, mime: frame?.mime ?? "image/png")
            if next.data.flatMap(UIImage.init(data:)) != nil {
                screenWatch.receivedFrame()
            } else {
                screenWatch.failed("The latest screen frame could not be decoded.")
            }
        }
        .onChange(of: session.status) { _, status in
            switch status {
            case let .offline(message):
                session.clearScreen(of: bot.id)
                screenWatch.failed(message)
            case .unauthorized:
                session.clearScreen(of: bot.id)
                screenWatch.failed("This phone is no longer paired with the computer.")
            case .unpaired:
                session.clearScreen(of: bot.id)
                screenWatch.failed("Pair this phone with a computer to watch the screen.")
            case .connecting:
                if screenWatch.phase == .watching {
                    session.clearScreen(of: bot.id)
                    screenWatch.retry()
                }
            case .live:
                guard ComputerPresentationState.hasKnownComputer(current) else { return }
                if screenWatch.failureMessage != nil {
                    session.clearScreen(of: bot.id)
                    screenWatch.retry()
                }
            }
        }
        .onChange(of: current.computer) { _, _ in
            syncScreenWatch(resetFrame: true)
        }
        .onChange(of: current.cloudBackend) { _, _ in
            syncScreenWatch(resetFrame: true)
        }
        .onChange(of: current.busy) { _, busy in
            guard ComputerPresentationState.hasKnownComputer(current) else { return }
            session.clearScreen(of: bot.id)
            screenWatch.reset()
            if busy == true {
                screenWatch.begin()
            }
        }
        .task(id: "local-vm-\(current.id)-\(current.computer ?? "")") {
            guard current.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "vm" else { return }
            await session.refreshLocalVm(for: current)
        }
        .task(id: "\(computerSignature)-\(screenWatch.attempt)-\(current.busy == true)") {
            guard ComputerPresentationState.hasKnownComputer(current) else { return }
            guard current.busy == true else { return }
            if screenWatch.phase == .idle {
                if let streamFailure {
                    screenWatch.failed(streamFailure)
                } else if frame != nil {
                    if image != nil {
                        screenWatch.receivedFrame()
                    } else {
                        screenWatch.failed("The latest screen frame could not be decoded.")
                    }
                } else {
                    screenWatch.begin()
                    return
                }
            }
            guard screenWatch.isWaiting else { return }
            let attempt = screenWatch.attempt
            try? await Task.sleep(for: Self.firstFrameTimeout)
            guard !Task.isCancelled,
                  screenWatch.attempt == attempt,
                  screenWatch.isWaiting,
                  frame == nil,
                  current.busy == true
            else { return }
            screenWatch.timedOut()
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

            Text(headerStatusTitle)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(headerStatusColor)
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var content: some View {
        if case .watching = presentationState, let image {
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
                if canRetryScreen {
                    Button("Try again", action: retryScreen)
                        .buttonStyle(.borderedProminent)
                }
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

    private var localVmFooter: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Local VM")
                        .font(.system(size: 15, weight: .semibold))
                    Text(localVmStateTitle)
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.65))
                }
                Spacer(minLength: 8)
                if pendingLocalVmAction {
                    ProgressView()
                        .tint(.white)
                        .controlSize(.small)
                }
            }

            if let localVmError {
                Text(localVmError)
                    .font(.caption)
                    .foregroundStyle(.red)
            } else if let problem = localVmStatus?.problem, localVmStatus?.ready != true {
                Text(problem)
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.65))
                    .lineLimit(2)
            }

            HStack(spacing: 8) {
                if localVmStatus?.canCreate == true {
                    localVmActionButton(.create)
                }
                if localVmStatus?.canStop == true {
                    localVmActionButton(.stop)
                }
                if localVmStatus?.canRecreate == true {
                    localVmActionButton(.recreate)
                }
            }

            Text("Runs on the paired Mac. This phone only sends guarded VM actions.")
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.5))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }

    private var localVmStateTitle: String {
        switch localVmStatus?.state {
        case .ready: return "Ready"
        case .running: return "Starting"
        case .stopped: return "Stopped"
        case .missing: return "Not created"
        case .unavailable: return "Unavailable"
        case .unknown, nil: return "Checking…"
        }
    }

    private func localVmActionButton(_ action: LocalVmAction) -> some View {
        Button {
            localVmError = nil
            confirmingLocalVmAction = action
        } label: {
            Label(action.buttonTitle, systemImage: action.systemImage)
                .font(.system(size: 13, weight: .semibold))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(action == .stop ? .red : .blue)
        .disabled(pendingLocalVmAction)
    }

    @MainActor
    private func runLocalVmAction(_ action: LocalVmAction) async {
        localVmError = nil
        let result = await session.performLocalVmAction(action, for: current)
        if result == nil, !Task.isCancelled {
            localVmError = "That Local VM action could not be completed. Try again from this panel."
        }
    }

    private func retryScreen() {
        guard ComputerPresentationState.hasKnownComputer(current) else { return }
        restartScreenWatch()
    }

    private func syncScreenWatch(resetFrame: Bool) {
        guard ComputerPresentationState.hasKnownComputer(current) else {
            stopScreenWatch()
            screenWatch.failed(ComputerPresentationState.unavailableMessage(for: current))
            return
        }

        if resetFrame {
            session.clearScreen(of: bot.id)
            screenWatch.reset()
        }

        if !isWatchingScreen {
            isWatchingScreen = true
            session.watchScreen(of: bot.id)
        }

        // The view can be pushed after the stream has already failed. Seed
        // the lifecycle from the authoritative session status instead of
        // showing an unavailable card with a dead Retry action while the
        // timeout task is still waiting for its first frame.
        if let streamFailure {
            screenWatch.failed(streamFailure)
        } else if current.busy == true, frame != nil {
            if image == nil {
                screenWatch.failed("The latest screen frame could not be decoded.")
            } else {
                screenWatch.receivedFrame()
            }
        } else if current.busy == true, screenWatch.phase == .idle {
            screenWatch.begin()
        }
    }

    private func stopScreenWatch() {
        guard isWatchingScreen else { return }
        isWatchingScreen = false
        session.stopWatchingScreen(of: bot.id)
        screenWatch.reset()
    }

    private func restartScreenWatch() {
        session.clearScreen(of: bot.id)
        screenWatch.retry()
        if !isWatchingScreen {
            isWatchingScreen = true
        }
        // Keep the watcher count stable. Toggling stop→watch opens one
        // screens=off stream and then another screens=on stream back-to-back.
        session.refreshScreenWatch(of: bot.id)
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
