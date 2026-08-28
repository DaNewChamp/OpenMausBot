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
    @State private var savingDestination = false
    @State private var savingPhoto = false
    @State private var photoSaveMessage: String?
    @State private var localVmViewerURL: URL?
    @State private var localVmSurfaceError: String?
    @State private var vmTypeDraft = ""
    @State private var vmKeyboardTrigger = 0
    @FocusState private var vmKeyboardFocused: Bool

    private var localVmInteractive: Bool {
        isLocalVm && localVmStatus?.ready == true && session.localVmAccess
    }

    private var usingLiveViewer: Bool {
        localVmInteractive && localVmViewerURL != nil
    }

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
            && (current.busy == true || isLocalVm)
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

    private var selectedInstance: Instance? {
        AdvertisedModelCatalog.instance(id: current.modelSelection.instanceId, in: instances)
    }

    private var localVmDestinationEnabled: Bool {
        selectedInstance?.supportsLocalVmDestination == true
    }

    private var destination: String {
        current.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private var isLocalVm: Bool { destination == "vm" }

    private var wantsScreenPreview: Bool {
        current.busy == true || isLocalVm
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

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                header
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
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .background {
            InteractivePopGestureEnabler()
                .frame(width: 0, height: 0)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: presentationState)
        .safeAreaInset(edge: .bottom) {
            if localVmInteractive {
                localVmChrome
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
        .sheet(isPresented: $showingHelp) {
            computerHelpSheet
        }
        .sheet(isPresented: $showingControls) {
            computerControlsSheet
        }
        .onChange(of: vmKeyboardFocused) { _, focused in
            if !focused { vmTypeDraft = "" }
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
            await session.refreshLocalVm(for: current)
        }
        .task(id: "local-vm-preview-\(current.id)-\(current.computer ?? "")") {
            guard isLocalVm else { return }
            while !Task.isCancelled {
                await session.refreshLocalVmPreview(for: current)
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .task(id: "local-vm-viewer-\(current.id)-\(localVmStatus?.ready == true)-\(session.localVmAccess)") {
            guard localVmInteractive else {
                localVmViewerURL = nil
                return
            }
            let joined = await session.localVmViewerURL(for: current)
            localVmViewerURL = joined.url
            if let error = joined.error, joined.url == nil {
                localVmSurfaceError = error
            }
        }
        .task(id: "instances-\(current.id)") {
            if case let .loaded(loaded) = await session.loadInstances() {
                instances = loaded
            }
        }
        .task(id: "\(computerSignature)-\(screenWatch.attempt)-\(wantsScreenPreview)") {
            await runScreenWatchTimeoutTask()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            ChromeCircleButton(systemImage: "chevron.left") {
                Haptics.selection()
                dismiss()
            }
            .accessibilityLabel("Back")

            HStack(spacing: 8) {
                BotAvatarView(
                    bot: current,
                    size: 22,
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

            ChromeCircleButton(systemImage: "questionmark", weight: .medium) {
                Haptics.selection()
                showingHelp = true
            }
            .accessibilityLabel("Desktop help")

            Menu {
                Button {
                    selectDestination("vm")
                } label: {
                    Label("Local", systemImage: destination == "vm" ? "checkmark" : "laptopcomputer")
                }
                .disabled(savingDestination || !localVmDestinationEnabled)
                Button {
                    selectDestination("cloud")
                } label: {
                    Label("Cloud", systemImage: destination == "cloud" ? "checkmark" : "cloud")
                }
                .disabled(savingDestination)
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
                    Button("Open secure cloud viewer", systemImage: "display") {
                        confirmingDesktop = true
                    }
                }
            } label: {
                ChromeCircleButton(systemImage: "ellipsis")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Choose Local or Cloud")
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .background(Color.black.opacity(0.88))
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            if usingLiveViewer, let localVmViewerURL {
                VMViewerWebView(
                    url: localVmViewerURL,
                    keyboardTrigger: vmKeyboardTrigger,
                    onLoadFailed: { message in
                        localVmSurfaceError = message
                        self.localVmViewerURL = nil
                    }
                )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("\(current.name)'s Local VM")
            } else if case .watching = presentationState, let image, localVmInteractive {
                RemoteDesktopCanvas(
                    image: image,
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
            } else if case .watching = presentationState, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("\(current.name)'s computer")
            } else {
                stateCard
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            if localVmInteractive, !usingLiveViewer {
                vmHiddenKeyboardField
            }
        }
    }

    private var vmHiddenKeyboardField: some View {
        TextField("Type on the Local VM", text: $vmTypeDraft, axis: .vertical)
            .lineLimit(1...4)
            .focused($vmKeyboardFocused)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .opacity(0.01)
            .frame(width: 1, height: 1)
            .accessibilityHidden(true)
            .onSubmit {
                Task { await submitVmTypedText() }
            }
    }

    private var localVmChrome: some View {
        LocalVmInteractionChrome(
            canPaste: UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
            canCopy: image != nil,
            keyboardActive: vmKeyboardFocused,
            onPasteFromPhone: { Task { await pasteFromPhoneToVm() } },
            onCopyToPhone: { copyScreen() },
            onToggleKeyboard: { toggleVmKeyboard() }
        )
    }

    @MainActor
    private func toggleVmKeyboard() {
        Haptics.selection()
        if usingLiveViewer {
            vmKeyboardTrigger += 1
            return
        }
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
        vmKeyboardFocused = false
    }

    @MainActor
    private func sendLocalVmInput(_ body: [String: Any]) async {
        if let error = await session.sendLocalVmInput(for: current, body: body) {
            localVmSurfaceError = error
        }
    }

    @ViewBuilder
    private var stateCard: some View {
        switch presentationState {
        case .starting:
            VStack(spacing: 12) {
                ProgressView()
                    .tint(.white)
                    .controlSize(.regular)
                    .accessibilityHidden(true)
                Text("Starting desktop...")
                    .font(.body)
            }
            .foregroundStyle(Color.white)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Starting desktop")

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
                Text(destinationHelp)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.white.opacity(0.55))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 4)
                if localVmDestinationEnabled, canShowLocalVmControls, localVmStatus?.canCreate == true {
                    Button("Create Local VM") {
                        confirmingLocalVmAction = .create
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(pendingLocalVmAction || savingDestination)
                }
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
        if isLocalVm {
            return "Waiting for a desktop preview from the Local VM."
        }
        if current.cloudBackend == "vps" || current.computer == "local" {
            return "This phone can watch frames while the agent works. Control stays on the paired computer."
        }
        if current.busy == true {
            return "Waiting for the first frame."
        }
        return "This Bot's computer is captured while it is working."
    }

    private var destinationHelp: String {
        switch destination {
        case "vm":
            if !localVmDestinationEnabled {
                return "This engine cannot use Local VM. Grok’s computer tools still hit this Mac. Switch to Claude, Codex, or ACP on the profile, then pick Local and Create."
            }
            if canShowLocalVmControls, localVmStatus?.canCreate == true {
                return "Local VM is not created yet. Create it below, then open this screen again."
            }
            return "Running on Local VM. The desktop updates while this screen is open."
        case "cloud":
            return current.cloudBackend == "vps"
                ? "Running on your VPS. The phone can only watch."
                : "Running on Cloud. Open a live frame while the agent is working, or use the secure viewer from ···."
        case "local":
            return "Running on this Mac. Use ··· to switch to Local or Cloud."
        case "off":
            return "Computer access is off. Use ··· to switch to Local or Cloud."
        default:
            return "Use ··· to choose Local or Cloud."
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
            ChromeCircleButton(systemImage: "square.and.arrow.down", weight: .medium) {
                saveScreenToPhotos()
            }
            .disabled(image == nil || savingPhoto)
            .accessibilityLabel("Save to Photos")

            ChromeCircleButton(systemImage: "list.clipboard", weight: .medium) {
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

            ChromeCircleButton(systemImage: "square.grid.2x2", weight: .medium) {
                Haptics.selection()
                showingControls = true
            }
            .accessibilityLabel("Desktop controls")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(Color.black)
    }

    private var computerHelpSheet: some View {
        NavigationStack {
            List {
                Section("This screen") {
                    Text(startingMessage)
                }
                Section("How to use Local VM") {
                    Text("Tap ··· and choose Local, then Create Local VM. The desktop is a Linux container on the paired Mac. This phone shows that desktop while this screen is open.")
                    Text("Grok Reconstructed cannot use Local VM as an OpenMaus mount. It still has Grok’s own Mac tools, which is why “open your VM” reached this computer. Use Claude, Codex, or an ACP engine for Local VM.")
                }
                if let localVmStatus {
                    Section("Local VM") {
                        Text(localVmStateTitle)
                        if let problem = localVmStatus.problem, localVmStatus.ready != true {
                            Text(problem)
                        }
                    }
                }
            }
            .navigationTitle("Desktop")
            .navigationBarTitleDisplayMode(.inline)
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
                    destinationChoice("Local", mode: "vm", enabled: localVmDestinationEnabled)
                    destinationChoice("Cloud", mode: "cloud", enabled: true)
                } header: {
                    Text("Runs on")
                } footer: {
                    if localVmDestinationEnabled {
                        Text("Local is an isolated Linux desktop on the paired Mac. Cloud is the hosted box.")
                    } else {
                        Text("This engine cannot use Local VM. Switch to Claude, Codex, or ACP on the profile, or pick Cloud.")
                    }
                }
                if canOpenCloudViewer {
                    Button {
                        showingControls = false
                        confirmingDesktop = true
                    } label: {
                        Label("Open secure cloud viewer", systemImage: "display")
                    }
                }
                if canShowLocalVmControls {
                    Section {
                        Text(localVmStateTitle)
                        if pendingLocalVmAction {
                            ProgressView()
                        }
                        if let localVmError {
                            Text(localVmError).foregroundStyle(.red)
                        } else if let problem = localVmStatus?.problem, localVmStatus?.ready != true {
                            Text(problem).foregroundStyle(.secondary)
                        }
                        if localVmStatus?.canCreate == true {
                            Button("Create", systemImage: "plus.circle") {
                                showingControls = false
                                confirmingLocalVmAction = .create
                            }
                            .disabled(pendingLocalVmAction)
                        }
                        if localVmStatus?.canStop == true {
                            Button("Stop", systemImage: "stop.circle", role: .destructive) {
                                showingControls = false
                                confirmingLocalVmAction = .stop
                            }
                            .disabled(pendingLocalVmAction)
                        }
                        if localVmStatus?.canRecreate == true {
                            Button("Recreate", systemImage: "arrow.clockwise.circle") {
                                showingControls = false
                                confirmingLocalVmAction = .recreate
                            }
                            .disabled(pendingLocalVmAction)
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
                }
                if !canOpenCloudViewer && !canShowLocalVmControls {
                    Text(destinationHelp)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Controls")
            .navigationBarTitleDisplayMode(.inline)
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
        UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
        savingPhoto = false
        photoSaveMessage = "Saved"
        Haptics.impact(.light)
        Task {
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
        .disabled(!enabled || savingDestination)
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
