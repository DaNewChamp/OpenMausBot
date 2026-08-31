// A bot's computer, live.
//
// The phone can pick where the computer runs and watch a Local VM desktop
// while this screen is open. Interactive mouse/keyboard stays on the paired
// computer except for the secure Box viewer and guarded Local VM
// create/stop/recreate actions.
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
    @State private var showingHelp = false
    @State private var showingControls = false
    @State private var instances: [Instance] = []
    @State private var instancesLoading = true
    @State private var savingDestination = false
    @State private var savingPhoto = false
    @State private var photoSaveMessage: String?
    @State private var localVmViewerURL: URL?
    @State private var localVmSurfaceError: String?
    @State private var viewerLoadFailed = false
    @State private var viewerReady = false
    @State private var viewerGeneration = 0
    @State private var viewerFailureCount = 0
    @State private var localVmInputSuppressedUntil = Date.distantPast
    @State private var showingPhotoSettings = false
    @State private var vmTypeDraft = ""
    @State private var announcedLocalVmStatusEpisode: String?
    @FocusState private var vmKeyboardFocused: Bool
    @AppStorage("vmPointerMode") private var vmPointerModeRaw = VmPointerMode.trackpad.rawValue

    private var vmPointerMode: VmPointerMode {
        get { VmPointerMode(rawValue: vmPointerModeRaw) ?? .trackpad }
        nonmutating set { vmPointerModeRaw = newValue.rawValue }
    }

    private var localVmInteractive: Bool {
        isLocalVm && localVmStatus?.ready == true && session.localVmAccess
    }

    /// Clipboard toggle + keyboard chrome for every Local VM session,
    /// including while the desktop is still starting.
    private var showsLocalVmBottomChrome: Bool {
        isLocalVm && session.localVmAccess
    }

    private var usingLiveViewer: Bool {
        desktopSurface == .liveViewer && localVmViewerURL != nil
    }

    private var openingLiveViewer: Bool {
        isLocalVm && LocalVmDesktopPolicy.shouldJoinViewer(bot: current, snapshot: localVmSnapshot)
            && !viewerReady && !viewerLoadFailed
    }

    private static let firstFrameTimeout = ComputerWatchLifecycle.firstFrameTimeout

    private var frame: ScreenFrame? { session.state.screens[bot.id] }

    /// The bot as the stream last described it — `busy` is what tells us
    /// whether more frames are coming or this is the last one.
    private var current: Bot { session.state.bot(bot.id) ?? bot }

    private var image: UIImage? {
        frame?.data.flatMap(UIImage.init(data:))
    }

    private var localVmSnapshot: LocalVmDesktopPolicy.Snapshot {
        LocalVmDesktopPolicy.Snapshot(
            status: localVmStatus,
            accessGranted: session.localVmAccess,
            hasScreenshot: image != nil,
            viewerURLPresent: localVmViewerURL != nil,
            viewerFailed: viewerLoadFailed,
            viewerReady: viewerReady,
            instanceResolved: instanceResolved,
            destinationsLoading: instancesLoading
        )
    }

    private var desktopSurface: LocalVmDesktopPolicy.Surface {
        LocalVmDesktopPolicy.surface(bot: current, snapshot: localVmSnapshot)
    }

    private var presentationState: ComputerPresentationState {
        let decodeFailure = ComputerPresentationState.hasKnownComputer(current)
            && wantsScreenPreview
            && frame != nil
            && image == nil
            ? "The latest screen frame could not be decoded."
            : nil
        let loadFailure = ComputerPresentationState.streamLoadFailure(
            streamFailure: streamFailure,
            watchFailure: screenWatch.failureMessage,
            wantsScreenPreview: wantsScreenPreview
        )
        return ComputerPresentationState.resolve(
            bot: current,
            frame: image == nil ? nil : frame,
            loadFailure: loadFailure ?? decodeFailure,
            localVm: isLocalVm && loadFailure == nil && decodeFailure == nil ? localVmSnapshot : nil
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

    private var selectedInstance: Instance? {
        AdvertisedModelCatalog.instance(id: current.modelSelection.instanceId, in: instances)
    }

    private var instanceResolved: Bool {
        selectedInstance != nil
    }

    private var destinationsSelectable: Bool {
        CalmSurfacePolicy.destinationsSelectable(
            isLoading: instancesLoading,
            instanceResolved: instanceResolved
        )
    }

    private var localVmDestinationEnabled: Bool {
        guard destinationsSelectable else { return false }
        return selectedInstance?.supportsLocalVmDestination ?? false
    }

    private var localVmDestinationDisabledReason: String {
        selectedInstance?.localVmDestinationDisabledReason
            ?? "Checking engine capabilities…"
    }

    private var destination: String {
        current.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private var isLocalVm: Bool { destination == "vm" }

    private var localVmStatusPollingActive: Bool {
        LocalVmDesktopPolicy.statusPollingActive(
            isLocalVm: isLocalVm,
            accessDenied: session.localVmAccessDenied,
            connectionLive: session.status == .live
        )
    }

    private var localVmStatusErrorPresentation: LocalVmStatusErrorBanner.Presentation {
        LocalVmStatusErrorBanner.presentation(
            isLocalVm: isLocalVm,
            statusError: session.localVmStatusError,
            accessDenied: session.localVmAccessDenied,
            statusPollingActive: localVmStatusPollingActive
        )
    }

    private var wantsScreenPreview: Bool {
        if isLocalVm { return LocalVmDesktopPolicy.usesLiveScreenStreamTimeout() }
        return current.busy == true
    }

    private var streamFailure: String? {
        switch session.status {
        case let .offline(message):
            if ConnectionResiliencePolicy.shouldPreserveCachedScreen(
                unpaired: false,
                unauthorized: false
            ), image != nil {
                return nil
            }
            return message
        case .unauthorized: return "This phone is no longer paired with the computer."
        case .unpaired: return "Pair this phone with a computer to watch the screen."
        case .connecting, .live: return nil
        }
    }

    private var canRetryScreen: Bool {
        if isLocalVm { return desktopSurface.showsRetry || viewerLoadFailed }
        return ComputerPresentationState.hasKnownComputer(current)
            && wantsScreenPreview
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

    var body: some View {
        withComputerLifecycle(computerSheetsAndAlerts)
    }

    private var computerSheetsAndAlerts: some View {
        computerStack
            .toolbar(.hidden, for: .navigationBar)
            .navigationBarBackButtonHidden(true)
            .background {
                InteractivePopGestureEnabler()
                    .frame(width: 0, height: 0)
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: presentationState)
            .onChange(of: localVmStatusErrorPresentation.accessibilityEpisode) { _, episode in
                syncLocalVmStatusErrorAnnouncement(episode: episode)
            }
            .safeAreaInset(edge: .bottom) {
                if showsLocalVmBottomChrome {
                    VStack(spacing: 0) {
                        if vmKeyboardFocused && localVmInteractive {
                            VmKeyboardBar(
                                text: $vmTypeDraft,
                                isFocused: $vmKeyboardFocused,
                                onSend: { Task { await submitVmTypedText() } }
                            )
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        localVmChrome
                    }
                } else if case .watching = presentationState, image != nil {
                    VStack(spacing: 0) {
                        clipboardPasteBar
                        watchingControls
                    }
                }
            }
            .alert("Local VM", isPresented: Binding(
                get: { localVmSurfaceError != nil },
                set: { if !$0 { localVmSurfaceError = nil } }
            )) {
                Button("OK", role: .cancel) { localVmSurfaceError = nil }
            } message: {
                Text(localVmSurfaceError ?? "")
            }
            .alert("Photos", isPresented: $showingPhotoSettings) {
                Button(PhotoLibrarySavePolicy.settingsActionTitle) {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                Button("OK", role: .cancel) {}
            } message: {
                Text(PhotoLibrarySavePolicy.deniedMessage)
            }
            .sheet(isPresented: $showingHelp) {
                computerHelpSheet
            }
            .sheet(isPresented: $showingControls) {
                computerControlsSheet
            }
            .onChange(of: vmKeyboardFocused) { _, focused in
                if !focused { vmTypeDraft = "" }
            }
            .alert(CloudViewerPolicy.confirmTitle, isPresented: $confirmingDesktop) {
                Button("Cancel", role: .cancel) {}
                Button(CloudViewerPolicy.openDesktopTitle) { Task { await openDesktop() } }
            } message: {
                Text(CloudViewerPolicy.externalSemantics)
            }
            .sheet(
                isPresented: Binding(
                    get: { desktopURL != nil },
                    set: { if !$0 { desktopURL = nil } }
                )
            ) {
                if let desktopURL {
                    CloudDesktopBrowser(url: desktopURL)
                        .ignoresSafeArea(edges: .bottom)
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
    }

    private var computerStack: some View {
        ZStack(alignment: .top) {
            VBotSurface.background.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                if localVmStatusErrorPresentation.isVisible {
                    LocalVmStatusErrorBannerView(presentation: localVmStatusErrorPresentation) {
                        Haptics.selection()
                        Task { await session.refreshLocalVm(for: current) }
                    }
                }
                content
            }

            if let desktopError {
                Text(desktopError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 88)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .allowsHitTesting(false)
            }
        }
    }

    @ViewBuilder
    private func withComputerLifecycle<C: View>(_ content: C) -> some View {
        content
            .onAppear {
                syncScreenWatch(resetFrame: false)
            }
            .onDisappear {
                desktopURL = nil
                localVmViewerURL = nil
                viewerReady = false
                viewerLoadFailed = false
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
                    let preserve = ConnectionResiliencePolicy.shouldPreserveCachedScreen(
                        unpaired: false,
                        unauthorized: false
                    )
                    if preserve, image != nil {
                        break
                    }
                    if !preserve {
                        session.clearScreen(of: bot.id)
                    }
                    screenWatch.failed(message)
                case .unauthorized:
                    session.clearScreen(of: bot.id)
                    screenWatch.failed("This phone is no longer paired with the computer.")
                case .unpaired:
                    session.clearScreen(of: bot.id)
                    screenWatch.failed("Pair this phone with a computer to watch the screen.")
                case .connecting:
                    break
                case .live:
                    guard ComputerPresentationState.hasKnownComputer(current) else { return }
                    if wantsScreenPreview, screenWatch.failureMessage != nil, image == nil {
                        session.clearScreen(of: bot.id)
                        screenWatch.retry()
                    } else if !wantsScreenPreview, screenWatch.phase != .idle, image == nil {
                        screenWatch.reset()
                    }
                }
            }
            .onChange(of: current.computer) { _, newValue in
                let mode = newValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if mode == "vm" {
                    resetLiveViewerSession()
                } else {
                    localVmViewerURL = nil
                    viewerReady = false
                    viewerLoadFailed = false
                }
                syncScreenWatch(resetFrame: mode != "vm")
            }
            .onChange(of: current.cloudBackend) { _, _ in
                syncScreenWatch(resetFrame: true)
            }
            .onChange(of: current.busy) { _, busy in
                guard ComputerPresentationState.hasKnownComputer(current) else { return }
                if !isLocalVm {
                    session.clearScreen(of: bot.id)
                    screenWatch.reset()
                }
                if busy == true || isLocalVm {
                    screenWatch.begin()
                }
            }
            .task(id: "local-vm-\(current.id)-\(current.computer ?? "")") {
                guard isLocalVm else { return }
                while !Task.isCancelled {
                    await session.refreshLocalVm(for: current)
                    if !LocalVmDesktopPolicy.continueStatusPolling(
                        isLocalVm: true,
                        accessDenied: session.localVmAccessDenied
                    ) {
                        break
                    }
                    try? await Task.sleep(for: LocalVmDesktopPolicy.statusPollInterval)
                }
            }
            .task(id: "local-vm-preview-\(current.id)-\(current.computer ?? "")-\(session.localVmAccess)-\(viewerReady)") {
                guard isLocalVm else { return }
                guard LocalVmDesktopPolicy.shouldPollScreenshot(bot: current, snapshot: localVmSnapshot) else { return }
                while !Task.isCancelled {
                    await session.refreshLocalVmPreview(for: current)
                    if !LocalVmDesktopPolicy.shouldPollScreenshot(bot: current, snapshot: localVmSnapshot) {
                        break
                    }
                    try? await Task.sleep(for: LocalVmDesktopPolicy.screenshotPollInterval)
                }
            }
            .task(id: "local-vm-viewer-\(current.id)-\(destination)-\(localVmStatus?.ready == true)-\(session.localVmAccess)-\(viewerGeneration)") {
                guard isLocalVm else {
                    resetLiveViewerSession()
                    return
                }
                guard LocalVmDesktopPolicy.shouldJoinViewer(bot: current, snapshot: localVmSnapshot) else { return }
                viewerReady = false
                let joined = await session.localVmViewerURL(for: current)
                guard !Task.isCancelled else { return }
                localVmViewerURL = joined.url
                if joined.url == nil {
                    let reason: LocalVmDesktopPolicy.ViewerFailure = joined.staleTicket ? .staleTicket : .joinFailed
                    handleViewerFailure(joined.error ?? LocalVmDesktopPolicy.viewerConnectFailureMessage, reason: reason)
                }
            }
            .task(id: "instances-\(current.id)") {
                let hadCache = !instances.isEmpty
                if !hadCache { instancesLoading = true }
                defer { instancesLoading = false }
#if DEBUG
                if let preview = session.storePreviewInstance(matching: current) {
                    instances = [preview]
                    return
                }
#endif
                if case let .loaded(loaded) = await session.loadInstances() {
                    instances = loaded
                }
            }
            .task(id: "\(computerSignature)-\(screenWatch.attempt)-\(wantsScreenPreview)") {
                await runScreenWatchTimeoutTask()
            }
    }

    private var header: some View {
        HStack(spacing: 8) {
            GlassButton(systemImage: "chevron.left") {
                Haptics.selection()
                dismiss()
            }
            .accessibilityLabel("Back")

            HStack(spacing: 8) {
                BotAvatarView(
                    bot: current,
                    size: 28,
                    state: MausState.forBot(current, last: nil),
                    animated: !reduceMotion && current.isWorking
                )
                Text(current.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(current.name)

            Spacer(minLength: 8)

            GlassButton(systemImage: "questionmark", weight: .medium) {
                Haptics.selection()
                showingHelp = true
            }
            .accessibilityLabel("Desktop help")

            Menu {
                if !localVmDestinationEnabled {
                    Text(localVmDestinationDisabledReason)
                }
                Button {
                    selectDestination("vm")
                } label: {
                    Label("Local", systemImage: destination == "vm" ? "checkmark" : "laptopcomputer")
                }
                .disabled(savingDestination || !destinationsSelectable || !localVmDestinationEnabled)
                Button {
                    selectDestination("cloud")
                } label: {
                    Label("Cloud", systemImage: destination == "cloud" ? "checkmark" : "cloud")
                }
                .disabled(savingDestination || !destinationsSelectable)
                if canShowLocalVmControls {
                    Divider()
                    if localVmStatus?.canCreate == true {
                        Button("Create Local VM", systemImage: "plus.circle") {
                            confirmingLocalVmAction = .create
                        }
                        .disabled(pendingLocalVmAction)
                    }
                    if localVmStatus?.canStop == true {
                        Button("Stop Local VM", systemImage: "stop.circle", role: .destructive) {
                            confirmingLocalVmAction = .stop
                        }
                        .disabled(pendingLocalVmAction)
                    }
                    if localVmStatus?.canRecreate == true {
                        Button("Recreate Local VM", systemImage: "arrow.clockwise.circle") {
                            confirmingLocalVmAction = .recreate
                        }
                        .disabled(pendingLocalVmAction)
                    }
                }
                if canOpenCloudViewer {
                    Divider()
                    Button(CloudViewerPolicy.openDesktopTitle, systemImage: "display") {
                        confirmingDesktop = true
                    }
                    .disabled(openingDesktop)
                }
            } label: {
                GlassChromeGlyph(systemImage: "ellipsis")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Choose Local or Cloud")
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, VBotSurface.Space.chrome)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .background(VBotSurface.background.opacity(0.92))
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            VBotSurface.background

            if isLocalVm {
                localVmDesktop
            } else if case .watching = presentationState, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)
                    .accessibilityLabel("\(current.name)'s computer")
            } else {
                stateCard
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder
    private var localVmDesktop: some View {
        ZStack {
            if case .unavailable = desktopSurface {
                stateCard
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                if let image, !viewerReady {
                    localVmScreenshotSurface(image)
                }

                if let localVmViewerURL,
                   LocalVmDesktopPolicy.shouldJoinViewer(bot: current, snapshot: localVmSnapshot) || usingLiveViewer {
                    VMViewerWebView(
                        url: localVmViewerURL,
                        pointerMode: vmPointerMode,
                        generation: viewerGeneration,
                        onLoadSucceeded: { viewerReady = true },
                        onLoadFailed: { message, reason in
                            handleViewerFailure(message, reason: reason)
                        }
                    )
                    .opacity(viewerReady && !viewerLoadFailed ? 1 : 0)
                    .allowsHitTesting(viewerReady && !viewerLoadFailed)
                    .accessibilityHidden(!viewerReady)
                    .accessibilityLabel("\(current.name)'s Local VM")
                }

                if !viewerReady, image == nil {
                    CalmDesktopSkeleton(message: localVmStartingMessage)
                }

                if viewerLoadFailed, image != nil {
                    Button {
                        Haptics.selection()
                        retryLiveViewer()
                    } label: {
                        Label("Try live desktop again", systemImage: "arrow.clockwise")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.ultraThinMaterial, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func localVmScreenshotSurface(_ image: UIImage) -> some View {
        if desktopSurface.isInteractive || (localVmInteractive && desktopSurface != .screenshotWatchOnly) {
            RemoteDesktopCanvas(
                image: image,
                pointerMode: vmPointerMode,
                onClick: { x, y, button in
                    Task { await sendLocalVmInput(["action": "click", "x": x, "y": y, "button": button]) }
                },
                onScroll: { direction, clicks, x, y in
                    Task {
                        await sendLocalVmInput([
                            "action": "scroll",
                            "direction": direction,
                            "clicks": clicks,
                            "x": x,
                            "y": y,
                        ])
                    }
                }
            )
            .accessibilityLabel("\(current.name)'s computer")
        } else {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .accessibilityLabel("\(current.name)'s computer")
        }
    }

    private var localVmChrome: some View {
        LocalVmInteractionChrome(
            canPaste: UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
            canCopy: image != nil,
            canSave: image != nil,
            canType: localVmInteractive,
            keyboardActive: vmKeyboardFocused,
            pointerMode: Binding(
                get: { vmPointerMode },
                set: { mode in
                    guard vmPointerMode != mode else { return }
                    // The live desktop gesture can finish in the same event
                    // as the overlaid mode button. Ignore that one stale
                    // gesture so changing modes never clicks the VM.
                    localVmInputSuppressedUntil = Date().addingTimeInterval(0.35)
                    vmPointerMode = mode
                }
            ),
            onPasteFromPhone: { Task { await pasteFromPhoneToVm() } },
            onCopyToPhone: { copyScreen() },
            onSaveScreenshot: { saveScreenToPhotos() },
            onToggleKeyboard: { toggleVmKeyboard() }
        )
    }

    @MainActor
    private func toggleVmKeyboard() {
        Haptics.selection()
        if vmKeyboardFocused {
            vmKeyboardFocused = false
        } else {
            vmKeyboardFocused = true
        }
    }

    @MainActor
    private func pasteFromPhoneToVm() async {
        guard let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else { return }
        await sendLocalVmInput(["action": "type", "text": text])
    }

    @MainActor
    private func submitVmTypedText() async {
        let text = vmTypeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await sendLocalVmInput(["action": "type", "text": text])
        vmTypeDraft = ""
        if !usingLiveViewer {
            vmKeyboardFocused = false
        }
    }

    @MainActor
    private func sendLocalVmInput(_ body: [String: Any]) async {
        guard Date() >= localVmInputSuppressedUntil else { return }
        if let error = await session.sendLocalVmInput(for: current, body: body) {
            localVmSurfaceError = error
        }
    }

    @ViewBuilder
    private var stateCard: some View {
        switch presentationState {
        case .starting:
            CalmDesktopSkeleton(message: localVmStartingMessage)

        case .cloudViewerAvailable:
            VStack(spacing: 14) {
                Image(systemName: "display.and.arrow.down")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(.primary.opacity(0.9))
                Text(CloudViewerPolicy.boxReadyTitle)
                    .font(.body.weight(.semibold))
                Text(CloudViewerPolicy.boxReadyCopy)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                Text(CloudViewerPolicy.externalSemantics)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                Button(CloudViewerPolicy.openDesktopTitle) {
                    Haptics.selection()
                    confirmingDesktop = true
                }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: VBotSurface.Hit.minimum)
                .disabled(openingDesktop)
                .accessibilityLabel(CloudViewerPolicy.openDesktopTitle)
                .accessibilityHint(CloudViewerPolicy.externalSemantics)
                if openingDesktop {
                    ProgressView()
                        .padding(.top, 4)
                        .accessibilityLabel("Opening cloud desktop")
                }
            }
            .foregroundStyle(Color.primary)
            .padding(VBotSurface.Space.section)
            .vbotCard()
            .padding(.horizontal, VBotSurface.Space.page)

        case let .unavailable(message) where message == ComputerPresentationState.idleWaitingMessage:
            VStack(spacing: 14) {
                Image(systemName: "clock")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(.secondary)
                Text("Waiting for agent")
                    .font(.body.weight(.semibold))
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Text(destinationHelp)
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 4)
            }
            .foregroundStyle(Color.primary)
            .padding(VBotSurface.Space.section)
            .vbotCard()
            .padding(.horizontal, VBotSurface.Space.page)

        case let .unavailable(message):
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Color.orange)
                Text("Computer unavailable")
                    .font(.body.weight(.semibold))
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Text(destinationHelp)
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 4)
                if localVmDestinationEnabled, canShowLocalVmControls, localVmStatus?.canCreate == true {
                    Button("Create Local VM") {
                        confirmingLocalVmAction = .create
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                    .disabled(pendingLocalVmAction || savingDestination)
                }
                if localVmDestinationEnabled, canShowLocalVmControls, localVmStatus?.canRecreate == true {
                    Button("Recreate Local VM") {
                        confirmingLocalVmAction = .recreate
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                    .disabled(pendingLocalVmAction || savingDestination)
                }
                if canRetryScreen {
                    Button("Try again", action: retryScreen)
                        .buttonStyle(.borderedProminent)
                        .frame(minHeight: VBotSurface.Hit.minimum)
                }
            }
            .foregroundStyle(Color.primary)
            .padding(VBotSurface.Space.section)
            .vbotCard()
            .padding(.horizontal, VBotSurface.Space.page)

        case .watching:
            EmptyView()
        }
    }

    private var localVmStartingMessage: String {
        if isLocalVm {
            if localVmStatus?.ready == true {
                return openingLiveViewer ? "Opening live desktop…" : "Loading desktop preview…"
            }
            if let problem = localVmStatus?.problem, !(problem.isEmpty) {
                return problem
            }
            return localVmStateTitle == "Checking…" ? "Checking Local VM…" : localVmStateTitle
        }
        return "Starting desktop..."
    }

    private var startingMessage: String {
        if isLocalVm {
            return "Waiting for a desktop preview from the Local VM."
        }
        return ComputerPresentationState.startingCopy(
            computer: current.computer,
            cloudBackend: current.cloudBackend,
            busy: current.busy
        )
    }

    private var destinationHelp: String {
        switch destination {
        case "vm":
            if !localVmDestinationEnabled {
                return "\(localVmDestinationDisabledReason) Then pick Local and Create."
            }
            if canShowLocalVmControls, localVmStatus?.canCreate == true {
                return "Local VM is not created yet. Create it below, then open this screen again."
            }
            if canShowLocalVmControls, localVmStatus?.canRecreate == true {
                return "Recreate the Local VM below to start a fresh desktop."
            }
            return "Running on Local VM. The desktop updates while this screen is open."
        default:
            return ComputerPresentationState.destinationHelp(
                computer: destination,
                cloudBackend: current.cloudBackend
            ) ?? "Use ··· to choose Local or Cloud."
        }
    }

    private var clipboardPasteBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.on.clipboard")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Copy to composer")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.primary)
                Text("Paste iPhone clipboard into the active chat or the Local VM.")
                    .font(.caption2)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Button("Paste") {
                if isLocalVm, localVmStatus?.ready == true, session.localVmAccess,
                   let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !text.isEmpty {
                    Task {
                        _ = await session.sendLocalVmInput(
                            for: current,
                            body: ["action": "type", "text": text]
                        )
                    }
                } else {
                    pasteClipboardToComposer()
                }
            }
            .font(.footnote.weight(.semibold))
            .disabled(UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(VBotSurface.card.opacity(0.96))
    }

    private var watchingControls: some View {
        HStack(spacing: 12) {
            GlassButton(systemImage: "square.and.arrow.down", weight: .medium) {
                saveScreenToPhotos()
            }
            .disabled(image == nil || savingPhoto)
            .accessibilityLabel("Save to Photos")

            GlassButton(systemImage: "list.clipboard", weight: .medium) {
                copyScreen()
            }
            .disabled(image == nil)
            .accessibilityLabel("Copy screen")

            if let photoSaveMessage {
                Text(photoSaveMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if let watchCaption = ComputerPresentationState.watchCaption(for: current) {
                Text(watchCaption)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: 160, alignment: .trailing)
                    .accessibilityLabel(watchCaption)
            }

            GlassButton(systemImage: "square.grid.2x2", weight: .medium) {
                Haptics.selection()
                showingControls = true
            }
            .accessibilityLabel("Desktop controls")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(VBotSurface.background)
    }

    private var computerHelpSheet: some View {
        NavigationStack {
            List {
                Section("This screen") {
                    Text(startingMessage)
                        .vbotRowSurface()
                }
                Section("How to use Local VM") {
                    Text("Tap ··· and choose Local, then Create Local VM. The desktop is a Linux container on the paired Mac. This phone shows that desktop while this screen is open.")
                        .vbotRowSurface()
                    Text("Grok Reconstructed cannot use Local VM as an OpenMaus mount. It still has Grok’s own Mac tools, which is why “open your VM” reached this computer. Use Claude, Codex, or an ACP engine for Local VM.")
                        .vbotRowSurface()
                }
                if let localVmStatus {
                    Section("Local VM") {
                        Text(localVmStateTitle)
                            .vbotRowSurface()
                        if let problem = localVmStatus.problem, localVmStatus.ready != true {
                            Text(problem)
                                .vbotRowSurface()
                        }
                    }
                }
            }
            .navigationTitle("Desktop")
            .navigationBarTitleDisplayMode(.inline)
            .vbotGroupedChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showingHelp = false }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private var computerControlsSheet: some View {
        NavigationStack {
            List {
                Section {
                    if CalmSurfacePolicy.showsSkeleton(
                        isLoading: instancesLoading,
                        hasCachedRows: instanceResolved
                    ) {
                        CalmSkeletonList(rows: 2, label: "Loading computer destinations")
                            .vbotRowSurface()
                    } else {
                        destinationChoice("Local", mode: "vm", enabled: localVmDestinationEnabled)
                        destinationChoice("Cloud", mode: "cloud", enabled: destinationsSelectable)
                    }
                } header: {
                    Text("Runs on")
                } footer: {
                    if localVmDestinationEnabled {
                        Text("Local is an isolated Linux desktop on the paired Mac. Cloud is the hosted box.")
                    } else {
                        Text(localVmDestinationDisabledReason)
                    }
                }
                if canOpenCloudViewer {
                    Button {
                        showingControls = false
                        confirmingDesktop = true
                    } label: {
                        Label(CloudViewerPolicy.openDesktopTitle, systemImage: "display")
                    }
                    .disabled(openingDesktop)
                    .frame(minHeight: VBotSurface.Hit.minimum)
                    .accessibilityHint(CloudViewerPolicy.externalSemantics)
                    .vbotRowSurface()
                }
                if canShowLocalVmControls {
                    Section {
                        Text(localVmStateTitle)
                            .vbotRowSurface()
                        if pendingLocalVmAction {
                            ProgressView()
                                .vbotRowSurface()
                        }
                        if let localVmError {
                            Text(localVmError).foregroundStyle(.red)
                                .vbotRowSurface()
                        } else if let problem = localVmStatus?.problem, localVmStatus?.ready != true {
                            Text(problem).foregroundStyle(.secondary)
                                .vbotRowSurface()
                        }
                        if localVmStatus?.canCreate == true {
                            Button("Create", systemImage: "plus.circle") {
                                showingControls = false
                                confirmingLocalVmAction = .create
                            }
                            .disabled(pendingLocalVmAction)
                            .vbotRowSurface()
                        }
                        if localVmStatus?.canStop == true {
                            Button("Stop", systemImage: "stop.circle", role: .destructive) {
                                showingControls = false
                                confirmingLocalVmAction = .stop
                            }
                            .disabled(pendingLocalVmAction)
                            .vbotRowSurface()
                        }
                        if localVmStatus?.canRecreate == true {
                            Button("Recreate", systemImage: "arrow.clockwise.circle") {
                                showingControls = false
                                confirmingLocalVmAction = .recreate
                            }
                            .disabled(pendingLocalVmAction)
                            .vbotRowSurface()
                        }
                    } header: {
                        Text("Local VM")
                    } footer: {
                        Text("Runs on the paired Mac. This phone only sends guarded VM actions.")
                    }
                }
                if canRetryScreen {
                    Button("Try again", systemImage: "arrow.clockwise") {
                        showingControls = false
                        retryScreen()
                    }
                    .vbotRowSurface()
                }
                if !canOpenCloudViewer && !canShowLocalVmControls {
                    Text(destinationHelp)
                        .foregroundStyle(.secondary)
                        .vbotRowSurface()
                }
            }
            .navigationTitle("Controls")
            .navigationBarTitleDisplayMode(.inline)
            .vbotGroupedChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showingControls = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func copyScreen() {
        guard let image else { return }
        UIPasteboard.general.image = image
        Haptics.success()
    }

    private func pasteClipboardToComposer() {
        guard let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else { return }
        session.stageComposerText(text)
        Haptics.selection()
        dismiss()
    }

    private func saveScreenToPhotos() {
        guard let image else { return }
        savingPhoto = true
        photoSaveMessage = nil
        Task { @MainActor in
            let outcome = await ComputerPhotoSave.save(image)
            savingPhoto = false
            photoSaveMessage = PhotoLibrarySavePolicy.message(for: outcome)
            switch outcome {
            case .saved:
                Haptics.success()
            case .denied:
                showingPhotoSettings = true
            case .failed:
                Haptics.error()
            }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { photoSaveMessage = nil }
        }
    }

    private func destinationChoice(_ title: String, mode: String, enabled: Bool) -> some View {
        Button {
            selectDestination(mode)
        } label: {
            HStack {
                Text(title)
                Spacer()
                if destination == mode {
                    Image(systemName: "checkmark")
                }
            }
        }
        .disabled(!enabled || savingDestination || !destinationsSelectable)
        .vbotRowSurface()
    }

    private func selectDestination(_ mode: String) {
        guard mode == "vm" || mode == "cloud" else { return }
        guard destination != mode else { return }
        Haptics.selection()
        Task { await applyDestination(mode) }
    }

    @MainActor
    private func applyDestination(_ mode: String) async {
        savingDestination = true
        defer { savingDestination = false }
        if mode == "vm" {
            resetLiveViewerSession()
        }
        _ = await session.updateComputerDestination(
            BotComputerDestinationPatch(computer: mode),
            for: current
        )
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

    @MainActor
    private func syncLocalVmStatusErrorAnnouncement(episode: String?) {
        if episode == nil {
            announcedLocalVmStatusEpisode = nil
            return
        }
        guard let announcement = LocalVmStatusErrorBanner.accessibilityAnnouncement(
            lastAnnouncedEpisode: announcedLocalVmStatusEpisode,
            presentation: localVmStatusErrorPresentation
        ) else { return }
        UIAccessibility.post(notification: .announcement, argument: announcement)
        announcedLocalVmStatusEpisode = episode
    }

    @MainActor
    private func runLocalVmAction(_ action: LocalVmAction) async {
        localVmError = nil
        resetLiveViewerSession()
        let result = await session.performLocalVmAction(action, for: current)
        if result == nil, !Task.isCancelled {
            localVmError = "That Local VM action could not be completed. Try again from this panel."
        }
    }

    private func retryScreen() {
        if isLocalVm {
            retryLiveViewer()
        }
        guard ComputerPresentationState.hasKnownComputer(current) else { return }
        restartScreenWatch()
    }

    private func resetLiveViewerSession() {
        localVmViewerURL = nil
        viewerReady = false
        viewerLoadFailed = false
        viewerFailureCount = 0
        viewerGeneration += 1
    }

    private func retryLiveViewer() {
        viewerLoadFailed = false
        viewerReady = false
        localVmSurfaceError = nil
        viewerFailureCount = 0
        localVmViewerURL = nil
        viewerGeneration += 1
    }

    private func handleViewerFailure(_ message: String, reason: LocalVmDesktopPolicy.ViewerFailure) {
        if LocalVmDesktopPolicy.shouldRefreshTicket(failureCount: viewerFailureCount, reason: reason) {
            viewerFailureCount += 1
            viewerReady = false
            viewerLoadFailed = false
            localVmViewerURL = nil
            viewerGeneration += 1
            return
        }
        viewerLoadFailed = true
        viewerReady = false
        if image == nil {
            localVmSurfaceError = message
        }
    }

    private func runScreenWatchTimeoutTask() async {
        guard ComputerPresentationState.hasKnownComputer(current) else { return }
        guard wantsScreenPreview else { return }
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
              wantsScreenPreview
        else { return }
        screenWatch.timedOut()
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
        } else if wantsScreenPreview, frame != nil {
            if image == nil {
                screenWatch.failed("The latest screen frame could not be decoded.")
            } else {
                screenWatch.receivedFrame()
            }
        } else if wantsScreenPreview, screenWatch.phase == .idle {
            screenWatch.begin()
        } else if !wantsScreenPreview, screenWatch.phase != .idle {
            screenWatch.reset()
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
            desktopURL = nil
            desktopError = error.localizedDescription
        }
    }
}
