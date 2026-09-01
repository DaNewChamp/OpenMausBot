// The app's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// The parsing and folding live in CompanionCore. What lives here is the
// part that cannot be unit-tested and is the actual hard problem in a phone
// client — lifecycle. A phone loses its connection constantly: it locks, it
// backgrounds, it moves between wifi and cellular. So the stream is torn
// down deliberately when the app leaves the screen, and on the way back the
// server is asked what was missed rather than being asked for everything.
import Foundation
import OSLog
import SwiftUI
import CompanionCore
import UserNotifications
import UIKit

/// Stream lifecycle, in Console.app and the Xcode console. A companion that
/// is silently not connected looks exactly like one with nothing to say, so
/// the transitions are worth being able to read.
private let log = Logger(subsystem: "com.openmausbot.companion", category: "stream")

enum LocalVmAction: String, CaseIterable, Identifiable, Sendable {
    case create, stop, recreate

    var id: String { rawValue }
}

private struct ModelWriteIntent: Sendable {
    var bot: Bot
    var patch: BotModelPatch
}

@MainActor
final class Session: ObservableObject {
    enum Status: Equatable {
        case unpaired
        case connecting
        case live
        /// The token stopped working — revoked on the computer, most likely.
        case unauthorized
        case offline(String)
    }

    @Published private(set) var state = CompanionState()
    /// Queue acknowledgements observed by this phone. The Hub exposes no
    /// global queue snapshot, so this stays a local projection and is retired
    /// as transcript outcomes arrive or a full hydrate replaces the view.
    @Published private(set) var queueReceipts: [HomeActivityQueueReceipt] = []
    /// Advances only after the server has replaced local state with a full
    /// fleet hydrate. Resumed SSE connections leave it unchanged so views do
    /// not mistake a reconnect for an authoritative refresh.
    @Published private(set) var authoritativeHydrationRevision = 0
    @Published private(set) var connection: Connection?
    /// All computers paired to this phone. The selected connection remains
    /// exposed through `connection` so existing screens keep their behavior.
    @Published private(set) var connections: [Connection] = []
    @Published private(set) var status: Status = .unpaired
    /// Roster/settings projection of `status` plus whether this pairing has
    /// already been live. Views should not switch on Status for banner copy.
    var connectionBanner: ConnectionResiliencePolicy.Banner {
        let offline: String?
        if case let .offline(reason) = status { offline = reason } else { offline = nil }
        return ConnectionResiliencePolicy.banner(
            unpaired: status == .unpaired,
            unauthorized: status == .unauthorized,
            live: status == .live,
            previouslyLive: previouslyLive,
            connecting: status == .connecting,
            offlineReason: offline
        )
    }
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String? {
        didSet {
            if let message = actionError, RequestCancellation.matches(message) {
                actionError = nil
            }
        }
    }
    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// Distinguishes a real `.notDetermined` result from the in-memory value
    /// used while notification settings are still loading at launch.
    @Published private(set) var notificationAuthorizationResolved = false
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?
    /// Pairing may be opened while another computer is still saved.
    @Published private(set) var pairingRequested = false

    /// A notification response that should be pushed by the roster's
    /// NavigationStack after the exact detached task has been activated.
    @Published private(set) var notificationChat: Chat?
    /// A pin request in flight for each conversation. Pinning is server-backed
    /// rather than optimistic, so the roster disables the action until the
    /// acknowledgement arrives and cannot apply an older toggle out of order.
    @Published private(set) var pendingPinnedChats: Set<String> = []
    /// Phone-safe Local VM snapshots keyed by bot. The capability is granted
    /// per paired device by the desktop Companion and is deliberately false
    /// until this phone receives a successful, scrubbed status response.
    @Published private(set) var localVmStatuses: [String: LocalVmStatus] = [:]
    @Published private(set) var localVmAccess = false
    @Published private(set) var localVmAccessDenied = false
    /// Transient status-poll failures for the open Local VM panel. These must
    /// not surface through the global chat `actionError` banner.
    @Published private(set) var localVmStatusError: String?
    /// One lifecycle action per bot at a time. Keeping this in the session
    /// prevents repeated taps from racing the server-side lease/capacity guard.
    @Published private(set) var pendingLocalVmActions: Set<String> = []
    /// Companion-safe projection of the selected desktop engine. Mutations
    /// follow `primaryEngine`; OpenMaus roster fallback is read-only.
    @Published private(set) var engineSync: VBotEngineSync?
    /// Last advertised or reconstructed model catalog. Kept across offline
    /// reconnects so pickers can show a disabled cache instead of going blank.
    @Published private(set) var modelCatalog: [Instance] = []
    @Published private(set) var modelCatalogError: String?
    @Published private(set) var modelCatalogRefreshing = false
    /// Text staged from another screen (for example Computer paste) for the
    /// next opened chat composer to absorb.
    @Published var stagedComposerText: String?
    @Published var stagedShareImageData: Data?
    /// Prevents duplicate staging when `onAppear`, `scenePhase`, and
    /// `openmausbot://share` all fire during one foreground activation.
    private var shareInboxReadyForActivation = true

    private var client: CompanionClient?
    /// The device token, kept in memory so the client can be rebuilt when the
    /// dial moves to another stored host. The keychain remains the only place
    /// it is persisted.
    private var token: String?
    /// Which of the connection's stored hosts the next attempt dials. The
    /// walk advances on address-shaped failures and the winner is promoted —
    /// and persisted — when a stream goes live.
    private var rotation = CandidateRotation(hosts: [])
    private var streamTask: Task<Void, Never>?
    /// Best-effort authenticated route refresh started by the latest live SSE
    /// hello. Kept separate so endpoint discovery never stalls event delivery.
    private var endpointRefreshTask: Task<Void, Never>?
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    /// Identifies the in-flight authenticated endpoint snapshot. A slower
    /// older refresh must not overwrite a newer pairing or dial.
    private var endpointRefreshGeneration = 0
    /// True after this pairing has completed a live hello. Distinguishes
    /// first connect copy from reconnecting without a new Status case.
    @Published private(set) var previouslyLive = false
    /// True while `run()` is sleeping between attempts. Foregrounding then
    /// nudges a new dial instead of waiting out the backoff.
    private var inBackoff = false
    private var engineSyncGeneration = 0
    private var modelCatalogGate = ModelCatalogRefreshGate()
    private var modelUpdateGenerations: [String: Int] = [:]
    private var routerWriteGeneration = 0
    private let modelWriter = SerializedLatestWriter<String, ModelWriteIntent, Bot>()
    private let routerWriter = SerializedLatestWriter<String, VBotRouterPatch, VBotRouterState>()
    private var routerWriteOwner: InterruptedModelWritePolicy.RouterOwner?
    private var advertisedWritesInFlight: Set<String> = []
    private var routerWriteInFlight = false
    private var unconfirmedModelWrites: Set<String> = []
    private var unconfirmedRouterWrite = false
    /// Token bursts land here and publish on a frame cadence, so SwiftUI does
    /// not rebuild the chat on every provider delta.
    private var streamCoalescer = StreamCoalescer()
    private var queueReceiptStore = HomeActivityQueueReceiptStore()
    private var streamFlushTask: Task<Void, Never>?
    private var streamFlushDeadlineMs: Int?
    /// Last seq of a buffered delta that has not yet been folded. Held back
    /// so a reconnect can replay the burst if we disconnect mid-flush.
    private var bufferedStreamSeq: Int?
    private var reconnectDelay: UInt64 = 0
    /// Which computer panels are open. The stream is shared, but frames are
    /// keyed by bot, so a panel for the same bot cannot clear a frame another
    /// panel still needs.
    private var screenWatchers = ScreenWatchRegistry()
    /// Authenticated avatar bytes shared by roster, header, group and task
    /// surfaces. Both entry count and byte cost are bounded because one valid
    /// uploaded image may be 10 MB.
    private let avatarCache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.countLimit = 64
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    /// Concurrent first renders share one download. The id prevents an old
    /// request finishing after sign-out from removing a newer pairing's task
    /// for the same attachment path.
    private var avatarFetches: [String: (id: UUID, task: Task<Data?, Never>)] = [:]
    private var avatarCacheGeneration = 0
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false
    /// A notification can cold-launch the app before protected Keychain data
    /// is available. Retain the last explicitly tapped destination until the
    /// paired client can be rebuilt after unlock.
    private var pendingNotification: NotificationTarget?

    private var registry = CompanionConnectionRegistry()
    private static let connectionsKey = "companion.connections.v1"
    private static let connectionKey = "companion.connection"
    private static let pinnedOverridesKey = "companion.pinned-overrides"
    private static let appearanceOverridesBaseKey = "companion.appearance-overrides"
    private static let readReceiptsBaseKey = "companion.read-receipts"

    private static func loadPinnedOverrides() -> ConversationPinOverrides {
        guard let data = UserDefaults.standard.data(forKey: pinnedOverridesKey),
              let overrides = try? JSONDecoder().decode(ConversationPinOverrides.self, from: data)
        else { return ConversationPinOverrides() }
        return overrides
    }

    private func persistPinnedOverrides() {
        UserDefaults.standard.set(
            try? JSONEncoder().encode(state.pinnedOverrides),
            forKey: Self.pinnedOverridesKey
        )
    }

    private static func appearanceOverridesKey(for connectionID: String) -> String {
        "\(appearanceOverridesBaseKey).\(connectionID)"
    }

    private static func loadAppearanceOverrides(for connectionID: String) -> BotAppearanceOverrides {
        guard let data = UserDefaults.standard.data(forKey: appearanceOverridesKey(for: connectionID)),
              let overrides = try? JSONDecoder().decode(BotAppearanceOverrides.self, from: data)
        else { return BotAppearanceOverrides() }
        return overrides
    }

    private func persistAppearanceOverrides() {
        guard let connectionID = connection?.id else { return }
        UserDefaults.standard.set(
            try? JSONEncoder().encode(state.appearanceOverrides),
            forKey: Self.appearanceOverridesKey(for: connectionID)
        )
    }

    private static func readReceiptsKey(for connectionID: String) -> String {
        "\(readReceiptsBaseKey).\(connectionID)"
    }

    private static func loadReadReceipts(for connectionID: String) -> ConversationReadReceipts {
        guard let data = UserDefaults.standard.data(forKey: readReceiptsKey(for: connectionID)),
              let receipts = try? JSONDecoder().decode(ConversationReadReceipts.self, from: data)
        else { return ConversationReadReceipts() }
        return receipts
    }

    private func persistReadReceipts() {
        guard let connectionID = connection?.id else { return }
        UserDefaults.standard.set(
            try? JSONEncoder().encode(state.readReceipts),
            forKey: Self.readReceiptsKey(for: connectionID)
        )
    }

    private var visibleThreadId: String? {
        NotificationCoordinator.shared.foregroundThreadId
    }

    private func applyUnreadEffects(for frame: Frame, before: CompanionState) {
        let previousReceipts = state.readReceipts
        switch frame {
        case let .message(threadId, message):
            let alreadyPresent = before.transcript(forThread: threadId).contains { $0.id == message.id }
            state.applyUnreadOnFinalMessage(
                threadId: threadId,
                message: message,
                visibleThreadId: visibleThreadId,
                messageAlreadyPresent: alreadyPresent
            )
        case let .notify(notification):
            state.applyUnreadOnNotification(notification, visibleThreadId: visibleThreadId)
        case let .bot(bot):
            if !bot.unread {
                state.applyServerUnreadClear(forThread: bot.threadId)
            }
        case let .room(room):
            if !room.unread {
                state.applyServerUnreadClear(forThread: room.threadId)
            }
        default:
            break
        }
        state.reconcileUnreadIndicators(visibleThreadId: visibleThreadId)
        if state.readReceipts != previousReceipts { persistReadReceipts() }
    }

    // MARK: - Pairing

    init() {
        state.pinnedOverrides = Self.loadPinnedOverrides()
        _ = NotificationCoordinator.shared
        NotificationCoordinator.shared.responseHandler = { [weak self] target in
            Task { @MainActor in await self?.openNotification(target) }
        }
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-store-preview"),
           let url = Bundle.main.url(forResource: "StorePreview", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let fleet = try? JSONDecoder().decode(Fleet.self, from: data) {
            let preview = Connection(name: "Preview Mac", host: "preview.tailnet.ts.net", port: 8810)
            connection = preview
            registry = CompanionConnectionRegistry(connections: [preview], activeConnectionID: preview.id)
            connections = registry.connections
            state.hydrate(fleet)
            state.reconcileReadReceiptsAfterHydrate()
            state.reconcileUnreadIndicators(visibleThreadId: nil)
            StorePreviewHarness.apply(arguments: ProcessInfo.processInfo.arguments, to: &state)
            var previewAccess = false
            var previewDenied = false
            var previewStatuses: [String: LocalVmStatus] = [:]
            StorePreviewHarness.applyLocalVm(
                arguments: ProcessInfo.processInfo.arguments,
                access: &previewAccess,
                accessDenied: &previewDenied,
                statuses: &previewStatuses,
                bots: state.bots
            )
            localVmAccess = previewAccess
            localVmAccessDenied = previewDenied
            localVmStatuses = previewStatuses
            if let index = state.bots.firstIndex(where: { $0.id == "preview-parity" }) {
                state.bots[index].modelSelection = ModelSelection(instanceId: "cursor", model: "auto")
            }
            modelCatalog = Self.storePreviewProviderCatalog()
            recordHydration(resumed: false)
            status = .live
            previouslyLive = true
            return
        }
#endif
        restore()
        Task { await refreshNotificationAuthorization() }
    }

    /// Rebuild the last connection at launch.
    ///
    /// Three outcomes, and keeping them apart is the whole point. No saved
    /// connection: stay unpaired. A saved connection whose token reads back:
    /// connect. A saved connection whose token cannot be read *yet* — the
    /// locked keychain before a phone's first unlock after reboot, which is
    /// when iOS is most likely to have launched us in the background — hold
    /// on to it and try again. Only the middle case is a real pairing, and
    /// only the first should ever send someone back to the pairing screen.
    private func restore() {
        restorePending = false
        let restored = CompanionConnectionRegistryMigration.restore(
            registryData: UserDefaults.standard.data(forKey: Self.connectionsKey),
            legacyConnectionData: UserDefaults.standard.data(forKey: Self.connectionKey)
        )
        registry = restored.registry
        connections = registry.connections
        if restored.migratedLegacyConnection {
            persistRegistry()
            UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        }
        restoreSelectedConnection()
    }

    private func restoreSelectedConnection() {
        guard let saved = registry.activeConnection else {
            connection = nil
            return
        }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            // Keep the connection and say why. `.offline` rather than
            // `.unpaired` matters: the latter is what puts PairingView on
            // screen, and asking for a new code is the one recovery that
            // costs a walk to the computer.
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this phone to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else {
            registry.remove(id: saved.id)
            persistRegistry()
            connections = registry.connections
            restoreSelectedConnection()
            return
        }

        connection = saved
        state.appearanceOverrides = Self.loadAppearanceOverrides(for: saved.id)
        state.readReceipts = Self.loadReadReceipts(for: saved.id)
        token = stored
        // New connections honor the desktop's transport policy. Automatic
        // walking is credential-safe: protected routes stay protected, while
        // a legacy/local route is only tried when it was the exact saved route.
        rotation = CandidateRotation(endpoints: saved.orderedEndpoints)
        let first = rotation.currentEndpoint.map(saved.dialing) ?? saved
        client = CompanionClient(connection: first, token: stored)
        status = .connecting
    }

    /// Redeem a one-time pairing credential. On success the device token goes
    /// to the keychain and the connection to defaults — deliberately apart,
    /// so the thing that gets backed up is never the credential.
    func pair(
        with connection: Connection,
        credential: String,
        deviceName: String,
        pairRequestId: String
    ) async throws {
        var invited = connection
        // QR invites already carry this policy. Manual entry reaches the
        // session as a parsed Connection, so establish the same consent
        // boundary here before any health probe or credential redemption.
        if invited.allowedRouteKinds == nil {
            invited.establishRoutePolicyFromInvite()
        }
        let outcome = try await CompanionClient.pairFirstReachable(
            connection: invited,
            credential: credential,
            deviceName: deviceName,
            pairRequestId: pairRequestId
        )
        let paired = outcome.response
        // prefer the name the computer calls itself over the Bonjour label
        var stored = outcome.connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }
        // The computer knows every address it answers on, but redemption may
        // not widen the explicit route consent carried by the invite.
        stored.applyPairingAdvertisement(hosts: paired.hosts, endpoints: paired.endpoints)
        let winner = outcome.connection.activeEndpoint ?? CompanionEndpoint.direct(
            host: outcome.connection.host,
            port: outcome.connection.port,
            priority: 10_000
        )
        if let winner { stored.promote(winner) }
        if stored.endpoints?.isEmpty != false {
            stored.hosts = Array(stored.orderedHosts.prefix(8))
        }

        // Re-pairing an advertised route refreshes the existing record instead
        // of creating a duplicate row. New computers become the active one.
        if let existing = registry.matchingConnection(for: stored) {
            stored.id = existing.id
        }

        try Keychain.save(paired.token, for: stored.id)
        let firstPairing = registry.connections.isEmpty
        var updatedRegistry = registry
        updatedRegistry.upsert(stored)
        // Write the first-pair education marker before making the connection
        // restorable. If the process stops between these writes, an orphan
        // marker is harmless while unpaired; the reverse order could restore
        // a pairing which permanently skipped this step.
        // RootView may not have received iOS's notification status yet, and
        // the app may be relaunched before that asynchronous lookup finishes.
        CompanionPairingCommitSequence.persist {
            UserDefaults.standard.set(
                true,
                forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
            )
        } saveConnection: {
            UserDefaults.standard.set(try? JSONEncoder().encode(updatedRegistry), forKey: Self.connectionsKey)
        }

        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .pairingSucceeded
        )
        pairingRequested = false
        registry = updatedRegistry
        connections = registry.connections
        UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        self.connection = stored
        self.token = paired.token
        let liveRoutes = winner.map { route in
            [route] + stored.orderedEndpoints.filter { $0.url != route.url }
        } ?? stored.orderedEndpoints
        self.rotation = CandidateRotation(endpoints: liveRoutes)
        self.client = CompanionClient(
            connection: winner.map(stored.dialing) ?? stored,
            token: paired.token
        )
        self.state = CompanionState()
        clearQueueReceipts()
        self.engineSync = nil
        self.modelCatalog = []
        self.modelCatalogError = nil
        self.modelCatalogRefreshing = false
        engineSyncGeneration = EngineSyncPolicy.nextGeneration(after: engineSyncGeneration)
        modelCatalogGate.invalidate()
        routerWriteGeneration = EngineSyncPolicy.nextGeneration(after: routerWriteGeneration)
        modelUpdateGenerations.removeAll()
        resetInterruptedModelWriteTracking()
        localVmStatuses.removeAll()
        localVmAccess = false
        localVmAccessDenied = false
        pendingLocalVmActions.removeAll()
        UserDefaults.standard.removeObject(forKey: Self.pinnedOverridesKey)
        // A fresh pairing settles any restore that was still waiting on the
        // keychain — the token is in hand, so there is nothing left to retry.
        restorePending = false
        connect()
        Haptics.success()
        SoundEffects.playConnect()
    }

    func receivePairingURL(_ url: URL) {
        if url.host?.lowercased() == "share" {
            consumeShareInbox()
            return
        }
        guard connection == nil || pairingRequested else {
            actionError = "This phone is already paired. Unpair it in Settings before connecting it to another computer."
            return
        }
        guard let invite = PairingInvite.parse(url) else {
            actionError = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .received(invite)
        )
        pairingRequested = true
    }

    func beginPairing() { pairingRequested = true }

    func endPairing() {
        pairingRequested = false
        consumePairingInvite()
    }

    func consumePairingInvite() {
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .consumed
        )
    }

    func switchComputer(to id: String) {
        guard let saved = registry.connection(id: id) else { return }
        if connection?.id == id {
            connect()
            return
        }
        let stored: String?
        do {
            stored = try Keychain.token(for: id)
        } catch {
            actionError = (error as? KeychainError)?.isLocked == true
                ? "Unlock this iPhone, then try switching computers again."
                : error.localizedDescription
            return
        }
        guard let stored else {
            actionError = "This saved connection is no longer available on this iPhone. Remove it and pair again."
            return
        }
        stopActiveRuntime()
        registry.select(id: id)
        persistRegistry()
        connections = registry.connections
        configureActiveConnection(saved, token: stored)
        connect()
    }

    func forgetConnection(id: String) {
        guard registry.connection(id: id) != nil else { return }
        let wasActive = registry.activeConnectionID == id
        if wasActive { stopActiveRuntime() }
        Keychain.remove(id)
        registry.remove(id: id)
        persistRegistry()
        connections = registry.connections
        guard wasActive else { return }
        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        state = CompanionState()
        resetAvatarCache()
        NotificationCoordinator.shared.setBadge(0)
        restoreSelectedConnection()
        if connection != nil { connect() }
        if connections.isEmpty {
            UserDefaults.standard.removeObject(forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey)
        }
    }

    func signOut() {
        if let id = connection?.id ?? registry.activeConnectionID {
            forgetConnection(id: id)
            return
        }
        streamGeneration = ConnectionResiliencePolicy.nextGeneration(after: streamGeneration)
        endpointRefreshGeneration = ConnectionResiliencePolicy.nextGeneration(after: endpointRefreshGeneration)
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        restorePending = false
        pendingNotification = nil
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .signedOut
        )
        if let id = connection?.id {
            Keychain.remove(id)
            UserDefaults.standard.removeObject(forKey: Self.appearanceOverridesKey(for: id))
            UserDefaults.standard.removeObject(forKey: Self.readReceiptsKey(for: id))
        }
        UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        UserDefaults.standard.removeObject(forKey: Self.pinnedOverridesKey)
        UserDefaults.standard.removeObject(
            forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
        )
        connection = nil
        client = nil
        token = nil
        engineSync = nil
        modelCatalog = []
        modelCatalogError = nil
        modelCatalogRefreshing = false
        engineSyncGeneration = EngineSyncPolicy.nextGeneration(after: engineSyncGeneration)
        modelCatalogGate.invalidate()
        routerWriteGeneration = EngineSyncPolicy.nextGeneration(after: routerWriteGeneration)
        modelUpdateGenerations.removeAll()
        resetInterruptedModelWriteTracking()
        rotation = CandidateRotation(hosts: [])
        previouslyLive = false
        inBackoff = false
        resetStreamCoalescer()
        state = CompanionState()
        clearQueueReceipts()
        localVmStatuses.removeAll()
        localVmAccess = false
        localVmAccessDenied = false
        pendingLocalVmActions.removeAll()
        resetAvatarCache()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
    }

    private func configureActiveConnection(_ saved: Connection, token stored: String) {
        connection = saved
        state.appearanceOverrides = Self.loadAppearanceOverrides(for: saved.id)
        state.readReceipts = Self.loadReadReceipts(for: saved.id)
        token = stored
        rotation = CandidateRotation(endpoints: saved.orderedEndpoints)
        let first = rotation.currentEndpoint.map(saved.dialing) ?? saved
        client = CompanionClient(connection: first, token: stored)
        status = .connecting
    }

    private func stopActiveRuntime() {
        streamGeneration = ConnectionResiliencePolicy.nextGeneration(after: streamGeneration)
        endpointRefreshGeneration = ConnectionResiliencePolicy.nextGeneration(after: endpointRefreshGeneration)
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        restorePending = false
        pendingNotification = nil
        endLinger()
        resetStreamCoalescer()
        engineSync = nil
        modelCatalog = []
        modelCatalogError = nil
        modelCatalogRefreshing = false
        engineSyncGeneration = EngineSyncPolicy.nextGeneration(after: engineSyncGeneration)
        modelCatalogGate.invalidate()
        routerWriteGeneration = EngineSyncPolicy.nextGeneration(after: routerWriteGeneration)
        modelUpdateGenerations.removeAll()
        resetInterruptedModelWriteTracking()
        localVmStatuses.removeAll()
        localVmAccess = false
        localVmAccessDenied = false
        pendingLocalVmActions.removeAll()
        state = CompanionState()
        clearQueueReceipts()
        client = nil
        token = nil
        resetAvatarCache()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
    }

    private func persistRegistry() {
        if registry.connections.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.connectionsKey)
        } else {
            UserDefaults.standard.set(try? JSONEncoder().encode(registry), forKey: Self.connectionsKey)
        }
    }

    // MARK: - Lifecycle

    /// Called when the app comes to the front, and once at launch.
    func connect() {
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on: the
        // app is on screen, so the phone is in someone's hand and unlocked.
        if client == nil, restorePending { restore() }
        if client != nil, let pendingNotification {
            self.pendingNotification = nil
            Task { [weak self] in await self?.openNotification(pendingNotification) }
        }
        // back before the grace period ran out: keep the stream, drop the task
        endLinger()
        guard client != nil else { return }
        if streamTask != nil {
            if ConnectionResiliencePolicy.shouldNudgeReconnect(
                streamRunning: true,
                inBackoff: inBackoff,
                isLive: status == .live,
                isUnauthorized: status == .unauthorized,
                isUnpaired: status == .unpaired
            ) {
                restartStream()
            }
            return
        }
        reconnectDelay = 0
        inBackoff = false
        streamGeneration = ConnectionResiliencePolicy.nextGeneration(after: streamGeneration)
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run(generation: generation)
            guard ConnectionResiliencePolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: self.streamGeneration
            ) else { return }
            self.streamTask = nil
        }
    }

    /// Pull-to-refresh: reopen the stream, and hold the control open until
    /// the connection has actually settled one way or the other.
    ///
    /// `connect()` returns the moment the task is spawned, so a `refreshable`
    /// that only calls it snaps the spinner shut before a single byte has
    /// arrived — the gesture reads as "nothing happened", on precisely the
    /// occasion it exists for. Waiting for `status` to leave `.connecting`
    /// makes the spinner mean what it appears to mean; the deadline is there
    /// so a network that never answers still gives the control back.
    func refresh() async {
        restartStream()
        connect()
        let deadline = Date().addingTimeInterval(10)
        while status == .connecting, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    /// Ask the harness to include this bot's computer in the stream, for as
    /// long as something is showing it.
    ///
    /// This costs a reconnect, which is the right trade: the alternative is
    /// a base64 desktop capture arriving every few seconds for the whole
    /// session, including on cellular, whether or not anyone is looking.
    /// The reconnect resumes from the cursor, so nothing is missed.
    func watchScreen(of botId: String) {
        if screenWatchers.start(botId: botId) { restartStream() }
    }

    func stopWatchingScreen(of botId: String) {
        let result = screenWatchers.stop(botId: botId)
        guard result.stopped else { return }
        if result.lastForBot {
            state.clearScreen(botId)
        }
        if result.lastOverall {
            restartStream()
        }
    }

    /// Reopen the screen-enabled stream without changing the watcher count.
    /// A retry from a computer panel must not briefly drop from one watcher to
    /// zero: that would reconnect once with `screens=off` and immediately
    /// again with `screens=on`, wasting the retry and flashing stale state.
    func refreshScreenWatch(of botId: String) {
        if !screenWatchers.isWatching(botId: botId) {
            screenWatchers.start(botId: botId)
        }
        restartStream()
        connect()
    }

    /// Drop a cached frame without changing the number of open computer
    /// panels. Configuration and connection transitions use this to ensure a
    /// screen from an earlier capability is never rendered as current.
    func clearScreen(of botId: String) {
        state.clearScreen(botId)
    }

    /// Reopen the stream so its query string matches what we now want. The
    /// cursor survives, so this is a gap, not a reset.
    private func restartStream() {
        guard streamTask != nil else { return }
        streamTask?.cancel()
        streamTask = nil
        inBackoff = false
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        flushStreamCoalescer()
        streamGeneration = ConnectionResiliencePolicy.nextGeneration(after: streamGeneration)
        endpointRefreshGeneration = ConnectionResiliencePolicy.nextGeneration(after: endpointRefreshGeneration)
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        inBackoff = false
        endLinger()
    }

    private var lingerTask: UIBackgroundTaskIdentifier = .invalid
    private var lingerSleepTask: Task<Void, Never>?
    private var lingerGeneration = 0

    /// Leaving the screen: keep the stream alive for the grace period iOS
    /// allows rather than cutting it at once, so an approval that lands right
    /// after you swipe home still reaches the Live Activity and the island.
    /// After that, iOS suspends us anyway; disconnect cleanly so the cursor
    /// is written down at a known point.
    func linger() {
        guard streamTask != nil else { return }
        if lingerTask != .invalid {
            disconnect()
            return
        }
        let generation = streamGeneration
        lingerGeneration = generation
        let seconds = BackgroundPresencePolicy.streamLingerSeconds(isBackground: true)
        lingerTask = UIApplication.shared.beginBackgroundTask(withName: "companion.linger") { [weak self] in
            self?.disconnect()
        }
        lingerSleepTask?.cancel()
        lingerSleepTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, !Task.isCancelled else { return }
            guard self.lingerGeneration == generation, self.lingerTask != .invalid else { return }
            self.disconnect()
        }
    }

    private func endLinger() {
        lingerSleepTask?.cancel()
        lingerSleepTask = nil
        lingerGeneration = streamGeneration
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    private func applyStreamStatus(_ next: Status, generation: Int) {
        guard ConnectionResiliencePolicy.shouldApply(
            startedGeneration: generation,
            currentGeneration: streamGeneration
        ) else { return }
        status = next
    }

    private func run(generation: Int) async {
        while !Task.isCancelled {
            guard ConnectionResiliencePolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: streamGeneration
            ) else { return }
            guard let client else { return }
            inBackoff = false
            applyStreamStatus(.connecting, generation: generation)
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            do {
                // The query is fixed when the connection opens, so changing
                // it means a new connection — `restartStream()` cancels this
                // task and starts another. Cancellation is the only exit;
                // breaking out here instead would fall through to the "the
                // harness went away" path and flash a lost-connection banner
                // on what is actually a deliberate reconnect.
                for try await frame in try client.events(since: state.cursor, screens: screenWatchers.totalCount > 0) {
                    if Task.isCancelled { return }
                    guard ConnectionResiliencePolicy.shouldApply(
                        startedGeneration: generation,
                        currentGeneration: streamGeneration
                    ) else { return }
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // Fetch may finish after this stream was replaced.
                        // Live mutations stay behind shouldCommit.
                        var preparedFleet: Fleet?
                        if !resumed {
                            preparedFleet = try await fetchFleet()
                        }
                        let commit = StreamTransactionPolicy.hello(
                            startedGeneration: generation,
                            currentGeneration: streamGeneration,
                            resumed: resumed
                        )
                        guard commit.shouldApply else { return }
                        if commit.resetCoalescer {
                            resetStreamCoalescer()
                        }
                        if commit.hydrateFleet, let fleet = preparedFleet {
                            await applyPreparedHydrate(fleet, requiredGeneration: generation)
                            let afterHydrate = StreamTransactionPolicy.hello(
                                startedGeneration: generation,
                                currentGeneration: streamGeneration,
                                resumed: resumed
                            )
                            guard afterHydrate.applyHello else { return }
                            state.resetCursor(cursor)
                            recordHydration(resumed: false)
                        }
                        let live = StreamTransactionPolicy.hello(
                            startedGeneration: generation,
                            currentGeneration: streamGeneration,
                            resumed: resumed
                        )
                        guard live.applyHello else { return }
                        var next = state
                        next.apply(frame.frame)
                        state = next
                        previouslyLive = StreamTransactionPolicy.nextPreviouslyLive(
                            current: previouslyLive,
                            commit: live
                        )
                        applyStreamStatus(.live, generation: generation)
                        if live.rememberWorkingRoute {
                            rememberWorkingRoute()
                        }
                        if live.startEndpointRefresh {
                            refreshConnectionMetadata(using: client)
                        }
                        continue
                    }
                    applyIncomingFrame(frame)
                }
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                if previouslyLive {
                    applyStreamStatus(.connecting, generation: generation)
                } else {
                    applyStreamStatus(.offline("Lost the connection."), generation: generation)
                }
            } catch let error as APIError where error.isUnauthorized {
                log.error("stream refused: unauthorized")
                previouslyLive = StreamTransactionPolicy.nextPreviouslyLiveOnUnauthorized(
                    current: previouslyLive,
                    startedGeneration: generation,
                    currentGeneration: streamGeneration
                )
                applyStreamStatus(.unauthorized, generation: generation)
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if Task.isCancelled || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                if let urlError = error as? URLError, urlError.code == .cancelled {
                    log.info("stream closed by us")
                    return
                }
                guard ConnectionResiliencePolicy.shouldApply(
                    startedGeneration: generation,
                    currentGeneration: streamGeneration
                ) else { return }
                log.error("stream failed: \(ConnectionResiliencePolicy.safeFailureLog(error), privacy: .public)")
                let advice = failureMessage(for: error)
                if ConnectionResiliencePolicy.keepsRetryVisible(after: error) {
                    applyStreamStatus(.connecting, generation: generation)
                } else {
                    applyStreamStatus(.offline(advice), generation: generation)
                }
            }

            if Task.isCancelled { return }
            guard ConnectionResiliencePolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: streamGeneration
            ) else { return }
            // 1s, 2s, 4s… to 15s. A phone that woke on a network which is
            // not the laptop's should not hammer it. Foregrounding sets
            // `inBackoff` and `connect()` will cut this sleep short.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            inBackoff = true
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
            inBackoff = false
        }
    }

    private func streamAllows(_ authority: StreamTransactionPolicy.Authority) -> Bool {
        StreamTransactionPolicy.allows(authority, currentGeneration: streamGeneration)
    }

    private func fetchFleet() async throws -> Fleet? {
        guard let client else { return nil }
        return try await client.fleet(messages: 50)
    }

    private func applyPreparedHydrate(_ fleet: Fleet, requiredGeneration: Int) async {
        let authority = StreamTransactionPolicy.Authority.requiredGeneration(requiredGeneration)
        var commit = StreamTransactionPolicy.helperHydrate(
            startedGeneration: requiredGeneration,
            currentGeneration: streamGeneration
        )
        guard commit.applyFleet else { return }
        log.info("hydrated \(fleet.bots.count, privacy: .public) bots, \(fleet.groups.count, privacy: .public) rooms")
        resetStreamCoalescer()
        let previousAppearanceOverrides = state.appearanceOverrides
        state.hydrate(fleet)
        reconcileQueueReceipts(authoritativeRefresh: true)
        state.reconcileReadReceiptsAfterHydrate()
        state.reconcileUnreadIndicators(visibleThreadId: visibleThreadId)
        if commit.persistPins { persistPinnedOverrides() }
        if commit.persistAppearance, state.appearanceOverrides != previousAppearanceOverrides {
            persistAppearanceOverrides()
        }
        commit = StreamTransactionPolicy.helperHydrate(
            startedGeneration: requiredGeneration,
            currentGeneration: streamGeneration
        )
        if commit.retryAppearance, let client, streamAllows(authority) {
            await retryPendingAppearanceOverrides(using: client, authority: authority)
        }
        commit = StreamTransactionPolicy.helperHydrate(
            startedGeneration: requiredGeneration,
            currentGeneration: streamGeneration
        )
        guard commit.shouldApply, streamAllows(authority) else { return }
        NotificationCoordinator.shared.setBadge(state.unreadCount)
        if commit.refreshEngineCatalog {
            await refreshEngineSync(quietly: true, authority: authority)
            guard streamAllows(authority) else { return }
            _ = await loadModelCatalog(quietly: true, authority: authority)
        }
    }

    /// Snapshot the current stream generation, fetch, then apply only if that
    /// generation is still authoritative. Returns whether unconfirmed model
    /// writes may be cleared.
    @discardableResult
    private func hydrate() async throws -> Bool {
        let generation = streamGeneration
        guard let fleet = try await fetchFleet() else { return false }
        guard StreamTransactionPolicy.helperHydrate(
            startedGeneration: generation,
            currentGeneration: streamGeneration
        ).applyFleet else { return false }
        await applyPreparedHydrate(fleet, requiredGeneration: generation)
        return StreamTransactionPolicy.shouldClearUnconfirmedWrites(
            startedGeneration: generation,
            currentGeneration: streamGeneration
        )
    }

    private var hydrationRevision = HydrationRevision()

    private func recordHydration(resumed: Bool) {
        authoritativeHydrationRevision = hydrationRevision.record(resumed: resumed)
    }

    /// Fold one SSE frame. Token deltas are buffered and published together;
    /// everything else flushes that buffer first so a settled message cannot
    /// race its own tail.
    private func applyIncomingFrame(_ streamFrame: StreamFrame) {
        if case let .runtime(event) = streamFrame.frame {
            handleRuntime(event, seq: streamFrame.seq)
            return
        }
        flushStreamCoalescer()
        foldAndPublish(streamFrame.frame, seq: streamFrame.seq)
    }

    private func handleRuntime(_ event: RuntimeEvent, seq: Int?) {
        let now = StreamCoalescer.nowMs()
        switch streamCoalescer.ingest(event, nowMs: now) {
        case .none:
            if let seq {
                if streamFlushDeadlineMs != nil {
                    bufferedStreamSeq = seq
                } else {
                    var next = state
                    next.advance(to: seq)
                    state = next
                }
            }
        case .scheduleFlush(let deadline):
            bufferedStreamSeq = seq ?? bufferedStreamSeq
            scheduleStreamFlush(at: deadline)
        case .flushNow(let events):
            applyRuntimeEvents(events, seq: seq)
            cancelStreamFlush()
            if streamCoalescer.hasPending {
                scheduleStreamFlush(at: StreamCoalescer.nowMs() + StreamCoalescer.flushIntervalMs)
            }
        }
    }

    private func scheduleStreamFlush(at deadlineMs: Int) {
        if let existing = streamFlushDeadlineMs, existing <= deadlineMs { return }
        streamFlushDeadlineMs = deadlineMs
        streamFlushTask?.cancel()
        streamFlushTask = Task { @MainActor in
            let delay = max(0, deadlineMs - StreamCoalescer.nowMs())
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            }
            guard !Task.isCancelled else { return }
            flushStreamCoalescer()
        }
    }

    private func flushStreamCoalescer() {
        let events = streamCoalescer.flush(nowMs: StreamCoalescer.nowMs())
        let seq = bufferedStreamSeq
        cancelStreamFlush()
        guard !events.isEmpty else { return }
        applyRuntimeEvents(events, seq: seq)
    }

    private func applyRuntimeEvents(_ events: [RuntimeEvent], seq: Int?) {
        var next = state
        for event in events {
            next.apply(.runtime(event))
        }
        if let seq {
            next.advance(to: seq)
        } else if let bufferedStreamSeq {
            next.advance(to: bufferedStreamSeq)
        }
        state = next
        bufferedStreamSeq = nil
        reconcileQueueReceipts()
        state.reconcileUnreadIndicators(visibleThreadId: visibleThreadId)
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    private func foldAndPublish(_ frame: Frame, seq: Int?) {
        let previousOverrides = state.pinnedOverrides
        let previousAppearanceOverrides = state.appearanceOverrides
        let before = state
        var next = state
        next.apply(frame)
        next.advance(to: seq)
        state = next
        reconcileQueueReceipts()
        applyUnreadEffects(for: frame, before: before)
        if state.pinnedOverrides != previousOverrides { persistPinnedOverrides() }
        if state.appearanceOverrides != previousAppearanceOverrides { persistAppearanceOverrides() }
        if case let .notify(notification) = frame {
            guard !shouldSuppressNotification(for: notification.threadId) else { return }
            let bot = state.bot(notification.botId)
            Task { @MainActor in
                guard !shouldSuppressNotification(for: notification.threadId) else { return }
                let png = await notificationAvatarPNG(for: bot)
                NotificationCoordinator.shared.deliver(
                    notification,
                    sequence: seq,
                    avatarPNG: png
                )
            }
        }
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    private func cancelStreamFlush() {
        streamFlushTask?.cancel()
        streamFlushTask = nil
        streamFlushDeadlineMs = nil
    }

    private func resetStreamCoalescer() {
        streamCoalescer.reset()
        cancelStreamFlush()
        bufferedStreamSeq = nil
    }

    // MARK: - Which address to dial

    /// Turn a stream failure into advice a person can act on — and, when the
    /// failure is about the address rather than the pairing, move the dial to
    /// the next stored host so the retry that follows tries somewhere new.
    /// A 401 never reaches here: the unauthorized path returns above, which
    /// is what keeps a token problem from masquerading as an address walk.
    private func failureMessage(for error: Error) -> String {
        guard let connection else { return error.localizedDescription }
        let failed = rotation.currentEndpoint ?? connection.activeEndpoint ??
            CompanionEndpoint.direct(host: connection.host, port: connection.port, priority: 10_000)
        var next: String?
        if let candidate = rotation.advanceEndpoint(after: error), let token {
            client = CompanionClient(connection: connection.dialing(candidate), token: token)
            next = ConnectionResiliencePolicy.sanitizedRouteLabel(candidate)
            log.info("advancing companion route kind=\(candidate.kind.rawValue, privacy: .public)")
        }
        let failedHost = failed.map(ConnectionResiliencePolicy.sanitizedRouteLabel)
            ?? ConnectionResiliencePolicy.sanitizedRouteLabel(host: connection.host)
        if let urlError = error as? URLError {
            return ConnectionAdvice.message(
                for: urlError.code,
                host: failedHost,
                port: failed?.port ?? connection.port,
                tryingNext: next
            )
        }
        if let apiError = error as? APIError,
           case let .status(code, _) = apiError,
           ConnectionAdvice.shouldTryAnotherRoute(after: error) {
            return ConnectionAdvice.message(
                forGatewayStatus: code,
                host: failedHost,
                tryingNext: next
            )
        }
        return error.localizedDescription
    }

    /// Persist the route that carried a live stream. Legacy host lists promote
    /// it for the next launch; typed lists keep their explicit policy order.
    private func rememberWorkingRoute() {
        guard let winner = rotation.currentEndpoint, var updated = connection,
              updated.activeEndpoint?.url != winner.url else { return }
        updated.promote(winner)
        connection = updated
        UserDefaults.standard.set(try? JSONEncoder().encode(updated), forKey: Self.connectionKey)
    }

    /// Learn routes enabled after this phone originally paired. The endpoint
    /// response is authenticated with the existing device token and is a
    /// replacement snapshot, but failure is deliberately non-fatal: older
    /// sidecars return 404 and a transient refresh error must not tear down a
    /// perfectly healthy event stream.
    private func refreshConnectionMetadata(using sourceClient: CompanionClient) {
        guard let connectionID = connection?.id else { return }
        let workingEndpoint = rotation.currentEndpoint ?? sourceClient.connection.activeEndpoint
        let sourceBaseURL = sourceClient.connection.baseURL?.absoluteString
        endpointRefreshGeneration = ConnectionResiliencePolicy.nextGeneration(after: endpointRefreshGeneration)
        let generation = endpointRefreshGeneration
        endpointRefreshTask?.cancel()
        endpointRefreshTask = Task { [weak self] in
            do {
                let metadata = try await sourceClient.connectionMetadata()
                try Task.checkCancellation()
                guard let self,
                      ConnectionResiliencePolicy.shouldApplyEndpointRefresh(
                        startedGeneration: generation,
                        currentGeneration: self.endpointRefreshGeneration,
                        connectionID: connectionID,
                        currentConnectionID: self.connection?.id,
                        sourceBaseURL: sourceBaseURL,
                        currentBaseURL: self.client?.connection.baseURL?.absoluteString
                      ),
                      var updated = self.connection
                else { return }

                updated.reconcile(metadata)
                self.connection = updated
                UserDefaults.standard.set(
                    try? JSONEncoder().encode(updated),
                    forKey: Self.connectionKey
                )

                // Keep the currently live route first until this stream ends.
                // liveRotation applies the same no-downgrade policy used by
                // pairing, while the saved connection uses advertised
                // security priorities on the next launch.
                self.rotation = CandidateRotation(
                    endpoints: ConnectionResiliencePolicy.liveRotation(
                        working: workingEndpoint,
                        ordered: updated.orderedEndpoints
                    )
                )
                log.info("refreshed \(metadata.endpoints.count, privacy: .public) companion routes")
            } catch is CancellationError {
                return
            } catch {
                log.debug("endpoint refresh unavailable")
            }
        }
    }

    /// Replace the stored address by hand, keeping the pairing and its token.
    /// False when the text does not parse as a host or host:port.
    @discardableResult
    func updateAddress(_ text: String) -> Bool {
        guard var updated = connection, let parsed = Connection.parse(text) else { return false }
        guard let endpoint = parsed.activeEndpoint ?? CompanionEndpoint.direct(
            host: parsed.host,
            port: parsed.port,
            priority: 0
        ) else { return false }
        // A hand-entered route is fresh explicit consent. Reset the old
        // policy instead of allowing a local address to inherit protected or
        // unrelated LAN fallbacks from the previous pairing.
        updated.resetRoutePolicy(selecting: endpoint)
        connection = updated
        UserDefaults.standard.set(try? JSONEncoder().encode(updated), forKey: Self.connectionKey)
        rotation = CandidateRotation(endpoints: updated.orderedEndpoints)
        endpointRefreshGeneration = ConnectionResiliencePolicy.nextGeneration(after: endpointRefreshGeneration)
        if let token {
            client = CompanionClient(connection: updated.dialing(endpoint), token: token)
        }
        // Dial the new address now rather than on the next backoff tick —
        // someone who just typed an address is watching the banner.
        restartStream()
        connect()
        return true
    }

    // MARK: - Actions
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. Nothing here writes to `state` optimistically: the harness is
    // the source of truth, and a phone that draws its own version of events
    // is a phone that disagrees with the laptop.

    /// Keep queue acknowledgements at the app boundary rather than inside a
    /// chat view, so the home rail and updates sheet can share the same local
    /// observation without implying a Hub-wide queue snapshot.
    @discardableResult
    func recordQueueReceipt(
        _ receipt: MessageDeliveryReceipt,
        forThread threadId: String,
        enqueuedAt: Double = 0
    ) -> Bool {
        let observed = queueReceiptStore.observe(
            receipt,
            forThread: threadId,
            enqueuedAt: enqueuedAt
        )
        guard observed else { return false }
        queueReceiptStore.reconcile(
            threadId: threadId,
            transcript: state.visibleTranscript(forThread: threadId)
        )
        publishQueueReceipts()
        return true
    }

    /// Retire local queue acknowledgements after a transcript update. A full
    /// hydrate is the only operation allowed to discard receipts absent from
    /// the returned transcript; resumed streams retain the local unknowns.
    func reconcileQueueReceipts(
        forThread threadId: String,
        transcript: [Message],
        authoritativeRefresh: Bool = false
    ) {
        queueReceiptStore.reconcile(
            threadId: threadId,
            transcript: transcript,
            authoritativeRefresh: authoritativeRefresh
        )
        publishQueueReceipts()
    }

    private func reconcileQueueReceipts(authoritativeRefresh: Bool = false) {
        queueReceiptStore.reconcile(state: state, authoritativeRefresh: authoritativeRefresh)
        publishQueueReceipts()
    }

    private func publishQueueReceipts() {
        let receipts = queueReceiptStore.receipts
        if queueReceipts != receipts { queueReceipts = receipts }
    }

    private func clearQueueReceipts() {
        queueReceiptStore = HomeActivityQueueReceiptStore()
        if !queueReceipts.isEmpty { queueReceipts = [] }
    }

    @discardableResult
    func send(
        _ text: String,
        to chat: Chat,
        mode: MessageDeliveryMode = .auto
    ) async -> MessageDeliveryReceipt? {
        guard let client else { return nil }
        do {
            if !(await reconcileInterruptedModelWriteIfNeeded(for: chat)) {
                return nil
            }
            switch chat {
            case let .bot(bot):
                if VBotMutationRouting.target(for: engineSync) == .grokReconstructed {
                    return try await sendReconstructed(text, toBot: bot.id, mode: mode)
                }
                return try await client.send(text: text, toBot: bot.id, mode: mode)
            case let .room(room):
                if VBotMutationRouting.target(for: engineSync) == .grokReconstructed {
                    actionError = "Grok Reconstructed cannot send to a group from this app."
                    return nil
                }
                return try await client.send(text: text, toRoom: room.id, mode: mode)
            }
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            actionError = error.localizedDescription
        }
        return nil
    }

    /// Upload one image selected by the native composer. The server is the
    /// source of the absolute path; the client validates that the response is
    /// an app-owned generated attachment before the path can enter a prompt.
    func uploadAttachment(data: Data, mime: String) async throws -> UploadedAttachment {
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            return try await client.uploadAttachment(data: data, mime: mime)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    /// Fetch a transcript attachment through the paired, same-origin route.
    /// A malformed path is rejected by CompanionCore before URL construction.
    func attachmentData(path: String) async -> Data? {
        guard let client else { return nil }
        do {
            return try await client.attachment(path: path)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            return nil
        } catch {
            return nil
        }
    }

    func answer(chat: Chat, card: OptionCard, choice: String, rememberingPermission: Bool = true) async {
        guard let requestId = card.requestId else { return }
        if rememberingPermission, card.shouldRememberPermission(for: choice), case let .bot(bot) = chat {
            await alwaysAllow(bot: bot, card: card)
        }
        await answer(
            threadId: chat.threadId,
            requestId: requestId,
            choice: choice,
            isPermission: card.isPermission
        )
    }

    /// The same answer, from something that only has the ids — the Live
    /// Activity's buttons.
    func answer(threadId: String, requestId: String, choice: String, isPermission: Bool) async {
        await perform {
            // Permission cards answer allow/deny; a question answers with
            // the chosen text. The harness tells them apart by `behavior`.
            let behavior = OptionCard.responseBehavior(for: choice, isPermission: isPermission)
            if behavior != "answer" {
                try await $0.respond(
                    threadId: threadId,
                    requestId: requestId,
                    behavior: behavior
                )
            } else {
                try await $0.respond(threadId: threadId, requestId: requestId, behavior: "answer", message: choice)
            }
        }
    }

    /// "Always allow" — the grant key comes from the card, never from
    /// anything derived here, so the phone and the harness cannot disagree
    /// about what was just permitted.
    func alwaysAllow(bot: Bot, card: OptionCard) async {
        guard let key = card.allowKey else { return }
        await perform { try await $0.alwaysAllow(botId: bot.id, key: key) }
    }

    /// Make a new bot. The harness chooses its name, colour and greeting, so
    /// one made here is indistinguishable from one made on the desktop.
    ///
    /// Creating a bot does not broadcast — the desktop adds it optimistically
    /// too — so the new bot is folded in here rather than waited for. Return
    /// it so the caller can open it, which is the only reason anyone taps the
    /// button.
    @discardableResult
    func createBot() async -> Bot? {
        guard let client else { return nil }
        do {
            let bot = try await client.createBot()
            state.apply(.bot(bot))
            return bot
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Make a room from the phone. Same shape as `createBot`: fold it in
    /// rather than wait for a broadcast, and hand it back so it can be opened.
    @discardableResult
    func createRoom(name: String?, memberIds: [String]) async -> Room? {
        guard let client else { return nil }
        do {
            let room = try await client.createRoom(name: name, memberIds: memberIds)
            state.apply(.room(room))
            return room
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Pin or unpin immediately. Confirmations belong on destructive work,
    /// not on a home-strip toggle.
    func togglePinned(_ chat: Chat) {
        Task { _ = await setPinned(!chat.pinned, for: chat) }
    }

    /// Pin or unpin a conversation on the paired computer. The returned
    /// record is authoritative: state is folded only after the narrow server
    /// route acknowledges the requested value.
    @discardableResult
    func setPinned(_ pinned: Bool, for chat: Chat) async -> Chat? {
        guard let client, !pendingPinnedChats.contains(chat.stableID) else { return nil }
        pendingPinnedChats.insert(chat.stableID)
        defer { pendingPinnedChats.remove(chat.stableID) }
        do {
            switch chat {
            case let .bot(bot):
                let result = try await client.setPinnedResult(pinned, botId: bot.id)
                guard !Task.isCancelled else { return nil }
                switch result {
                case let .updated(updated):
                    state.apply(.bot(updated))
                    persistPinnedOverrides()
                    Haptics.success()
                    return .bot(updated)
                case .unsupported:
                    state.setLocalPinned(pinned, for: chat.stableID)
                    persistPinnedOverrides()
                    Haptics.success()
                    return state.bot(bot.id).map(Chat.bot) ?? .bot(bot)
                }
            case let .room(room):
                let result = try await client.setPinnedResult(pinned, roomId: room.id)
                guard !Task.isCancelled else { return nil }
                switch result {
                case let .updated(updated):
                    state.apply(.room(updated))
                    persistPinnedOverrides()
                    Haptics.success()
                    return .room(updated)
                case .unsupported:
                    state.setLocalPinned(pinned, for: chat.stableID)
                    persistPinnedOverrides()
                    Haptics.success()
                    return state.rooms.first(where: { $0.id == room.id }).map(Chat.room) ?? .room(room)
                }
            }
        } catch {
            if !Task.isCancelled, !error.isCancellation {
                actionError = error.localizedDescription
                Haptics.error()
            }
            return nil
        }
    }

    func interrupt(bot: Bot) async {
        await interrupt(chat: .bot(bot))
    }

    func interrupt(chat: Chat) async {
        await perform {
            if VBotMutationRouting.target(for: engineSync) == .grokReconstructed {
                switch chat {
                case let .bot(bot):
                    _ = try await $0.stopReconstructedBot(botId: bot.id)
                case .room:
                    throw APIError.status(
                        code: 409,
                        message: "Grok Reconstructed cannot stop a group from this app."
                    )
                }
                return
            }
            switch chat {
            case let .bot(bot): try await $0.interrupt(botId: bot.id)
            case let .room(room): try await $0.interrupt(roomId: room.id)
            }
        }
    }

    /// Ask for one fresh cloud viewer URL. Unlike ordinary actions this
    /// returns the value to a browser sheet and never writes it to app state.
    func cloudDesktop(for bot: Bot) async throws -> URL {
        guard ComputerPresentationState.supportsCloudViewer(bot) else {
            throw APIError.transport(CloudViewerPolicy.interactiveUnavailable)
        }
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            let minted = try await client.cloudDesktop(botId: bot.id)
            guard let url = CloudViewerPolicy.validatedJoinURL(minted.url) else {
                throw APIError.transport(CloudViewerPolicy.invalidAddressMessage)
            }
            return url
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    /// Read the phone-safe status for one bot's Mac-hosted Local VM. A 403 or
    /// a missing route means this paired device has no capability; it is not a
    /// reason to show a broken VM control surface on the phone.
    func refreshLocalVm(for bot: Bot) async {
        guard let client else { return }
        do {
            let snapshot = try await client.localVmStatus(botId: bot.id)
            guard !Task.isCancelled else { return }
            localVmAccess = true
            localVmAccessDenied = false
            localVmStatusError = nil
            localVmStatuses[bot.id] = snapshot
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            localVmAccess = false
            localVmAccessDenied = true
            localVmStatusError = nil
            localVmStatuses.removeAll()
        } catch let error as APIError {
            if case let .status(code, _) = error, code == 403 || code == 404 {
                localVmAccess = false
                localVmAccessDenied = true
                localVmStatusError = nil
                localVmStatuses.removeValue(forKey: bot.id)
            } else if !Task.isCancelled {
                localVmStatusError = error.localizedDescription
            }
        } catch {
            if !Task.isCancelled { localVmStatusError = error.localizedDescription }
        }
    }

    /// Capture the bot's Local VM desktop while the Computer panel is open.
    /// SSE frames only arrive while a turn is running; this is the idle
    /// preview Grok Bot shows. Failures here are not a chat-level error.
    func refreshLocalVmPreview(for bot: Bot) async {
        guard let client else { return }
        let computer = bot.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard computer == "vm" else { return }
        do {
            let capture = try await client.localVmScreenshot(botId: bot.id)
            guard !Task.isCancelled else { return }
            if let frame = ScreenFrame.fromCapture(capture.image) {
                state.screens[bot.id] = frame
            }
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            localVmAccess = false
            localVmAccessDenied = true
            localVmStatuses.removeAll()
        } catch let error as APIError {
            if case let .status(code, _) = error, code == 403 || code == 404 {
                localVmAccess = false
                localVmAccessDenied = true
            }
        } catch {
            return
        }
    }

    func localVmStatus(for bot: Bot) -> LocalVmStatus? {
        localVmStatuses[bot.id]
    }

    func localVmViewerURL(for bot: Bot) async -> (url: URL?, error: String?, staleTicket: Bool) {
        guard localVmAccess, let client else {
            return (nil, LocalVmDesktopPolicy.accessOffMessage, false)
        }
        guard let base = client.connection.baseURL else { return (nil, nil, false) }
        var attempt = 0
        while attempt < LocalVmDesktopPolicy.joinNotReadyRetryLimit {
            do {
                let join = try await client.localVmJoin(botId: bot.id)
                guard join.ready else { return (nil, LocalVmDesktopPolicy.viewerNotReadyMessage, false) }
                let url = URL(string: join.viewerPath, relativeTo: base)?.absoluteURL
                return (url, url == nil ? LocalVmDesktopPolicy.viewerAddressInvalidMessage : nil, false)
            } catch let error as APIError {
                if case let .status(code, message) = error {
                    switch LocalVmDesktopPolicy.joinHTTPOutcome(statusCode: code, attempt: attempt) {
                    case .retryNotReady:
                        attempt += 1
                        try? await Task.sleep(for: LocalVmDesktopPolicy.joinNotReadyRetryDelay)
                        continue
                    case .staleTicket:
                        return (nil, LocalVmDesktopPolicy.staleTicketMessage, true)
                    case .notReadyExhausted:
                        return (nil, message ?? LocalVmDesktopPolicy.viewerNotReadyMessage, false)
                    case .transientFailure:
                        return (nil, Self.localVmSurfaceError(error), false)
                    }
                }
                return (nil, Self.localVmSurfaceError(error), false)
            } catch {
                return (nil, error.localizedDescription, false)
            }
        }
        return (nil, LocalVmDesktopPolicy.viewerNotReadyMessage, false)
    }

    @discardableResult
    func sendLocalVmInput(for bot: Bot, body: [String: Any]) async -> String? {
        guard localVmAccess, let client else {
            return "Enable Local VM access for this phone in OpenMausBot → Settings → Companion."
        }
        do {
            let result = try await client.localVmInput(botId: bot.id, body: body)
            if result.isError { return result.text }
            await refreshLocalVmPreview(for: bot)
            return nil
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            localVmAccess = false
            localVmAccessDenied = true
            localVmStatuses.removeAll()
            return error.localizedDescription
        } catch let error as APIError {
            return Self.localVmSurfaceError(error)
        } catch {
            return Task.isCancelled ? nil : error.localizedDescription
        }
    }

    private static func localVmSurfaceError(_ error: APIError) -> String {
        guard case let .status(code, message) = error else { return error.localizedDescription }
        if code == 403,
           let message,
           message.contains("Local VM access is managed per phone") {
            return "This phone needs an updated companion on your Mac. Open OpenMausBot on the computer, then restart the sidecar or redeploy the hosted runtime."
        }
        return error.localizedDescription
    }

    /// Run one of the three guarded per-bot Local VM operations. The server
    /// owns all image, lease, idle and capacity decisions; this method merely
    /// projects its safe response back into the Computer panel.
    @discardableResult
    func performLocalVmAction(_ action: LocalVmAction, for bot: Bot) async -> LocalVmStatus? {
        guard localVmAccess, let client, !pendingLocalVmActions.contains(bot.id) else { return nil }
        pendingLocalVmActions.insert(bot.id)
        defer { pendingLocalVmActions.remove(bot.id) }
        do {
            let next: LocalVmStatus
            switch action {
            case .create: next = try await client.createLocalVm(botId: bot.id)
            case .stop: next = try await client.stopLocalVm(botId: bot.id)
            case .recreate: next = try await client.recreateLocalVm(botId: bot.id)
            }
            guard !Task.isCancelled else { return nil }
            localVmAccess = true
            localVmAccessDenied = false
            localVmStatuses[bot.id] = next
            await refreshLocalVmPreview(for: bot)
            return next
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            localVmAccess = false
            localVmAccessDenied = true
            localVmStatuses.removeAll()
        } catch let error as APIError {
            if case let .status(code, _) = error, code == 403 || code == 404 {
                localVmAccess = false
                localVmAccessDenied = true
                localVmStatuses.removeValue(forKey: bot.id)
            } else if !Task.isCancelled {
                actionError = error.localizedDescription
            }
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
        }
        return nil
    }

    func markRead(_ chat: Chat) async {
        state.markConversationRead(stableID: chat.stableID, threadId: chat.threadId)
        state.reconcileUnreadIndicators(visibleThreadId: visibleThreadId)
        persistReadReceipts()
        NotificationCoordinator.shared.setBadge(state.unreadCount)
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func markUnread(_ chat: Chat) async {
        guard let client else { return }
        do {
            switch chat {
            case let .bot(bot):
                try await client.markBotUnread(botId: bot.id)
                if var updated = state.bot(bot.id) {
                    updated.unread = true
                    state.apply(.bot(updated))
                }
            case let .room(room):
                try await client.markRoomUnread(roomId: room.id)
                if let index = state.rooms.firstIndex(where: { $0.id == room.id }) {
                    var updated = state.rooms[index]
                    updated.unread = true
                    state.apply(.room(updated))
                }
            }
            Haptics.selection()
        } catch {
            if !error.isCancellation { actionError = error.localizedDescription }
        }
    }

    func setBotHidden(_ bot: Bot, hidden: Bool) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.setBotHidden(botId: bot.id, hidden: hidden)
            state.apply(.bot(updated))
            Haptics.selection()
            return updated
        } catch {
            if !error.isCancellation { actionError = error.localizedDescription }
            return nil
        }
    }

    func updateGroupSetup(
        roomId: String,
        bulletin: String? = nil,
        defaultResponder: GroupResponder? = nil
    ) async -> Room? {
        guard let client else { return nil }
        do {
            let room = try await client.updateGroupSetup(
                roomId: roomId,
                bulletin: bulletin,
                defaultResponder: defaultResponder
            )
            state.apply(.room(room))
            Haptics.success()
            return room
        } catch {
            if !error.isCancellation { actionError = error.localizedDescription }
            return nil
        }
    }

    func stageComposerText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        stagedComposerText = trimmed
    }

    func resetShareInboxActivation() {
        shareInboxReadyForActivation = true
    }

    func discardShareStaging() {
        stagedComposerText = nil
        stagedShareImageData = nil
        try? ShareInbox.clearPending()
    }

    func takeShareStaging() -> ShareStaging {
        var staging = ShareStaging(text: stagedComposerText, imageData: stagedShareImageData)
        let taken = staging.take()
        stagedComposerText = staging.text
        stagedShareImageData = staging.imageData
        return taken
    }

    func consumeShareInbox() {
        guard shareInboxReadyForActivation else { return }
        guard let consumed = try? ShareInbox.consume() else { return }
        shareInboxReadyForActivation = false
        if let text = consumed.payload.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            stageComposerText(text)
        } else if let url = consumed.payload.url?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty {
            stageComposerText(url)
        }
        if let data = consumed.imageData {
            stagedShareImageData = data
        }
        Haptics.selection()
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            state.prepend(page, toThread: threadId)
            reconcileQueueReceipts(
                forThread: threadId,
                transcript: state.visibleTranscript(forThread: threadId)
            )
        } catch {
            if !error.isCancellation {
                actionError = error.localizedDescription
            }
        }
    }

    func image(threadId: String, messageId: String) async -> Data? {
        try? await client?.image(threadId: threadId, messageId: messageId)
    }

    func search(_ query: String) async -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let client else { return [] }
        do { return try await client.search(trimmed) }
        catch {
            actionError = error.localizedDescription
            return []
        }
    }

    /// Resolve a SQLite search hit into the live task/branch, load a page
    /// around it, and hand navigation the current chat record.
    func open(_ hit: SearchHit) async -> Chat? {
        guard let client else { return nil }
        do {
            if let botId = hit.botId, var bot = state.bot(botId) {
                if bot.threadId != hit.threadId {
                    bot = try await client.switchTask(botId: bot.id, threadId: hit.threadId)
                    state.apply(.bot(bot))
                }
                if !hit.onActivePath {
                    let leaf = try await client.setActiveBranch(botId: bot.id, messageId: hit.messageId)
                    state.apply(.thread(threadId: hit.threadId, activeLeafId: leaf))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                reconcileQueueReceipts(
                    forThread: hit.threadId,
                    transcript: state.visibleTranscript(forThread: hit.threadId)
                )
                focusedMessageId = hit.messageId
                return state.bot(bot.id).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               let room = state.rooms.first(where: { $0.id == groupId }) {
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                reconcileQueueReceipts(
                    forThread: hit.threadId,
                    transcript: state.visibleTranscript(forThread: hit.threadId)
                )
                focusedMessageId = hit.messageId
                return .room(room)
            }
        } catch { actionError = error.localizedDescription }
        return nil
    }

    func consumeFocus(_ messageId: String) {
        if focusedMessageId == messageId { focusedMessageId = nil }
    }

    func createTask(for bot: Bot, title: String?) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.createTask(botId: bot.id, title: title))) }
        catch { actionError = error.localizedDescription }
    }

    func switchTask(_ task: BotTask, for bot: Bot) async {
        guard let client, task.threadId != bot.threadId else { return }
        do { state.apply(.bot(try await client.switchTask(botId: bot.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    func renameTask(_ task: BotTask, for bot: Bot, title: String) async {
        guard let client else { return }
        do {
            try await client.renameTask(botId: bot.id, threadId: task.threadId, title: title)
            await refresh()
        } catch { actionError = error.localizedDescription }
    }

    func deleteTask(_ task: BotTask, for bot: Bot) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.deleteTask(botId: bot.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    // MARK: - Agent profile

    enum ModelCatalogLoadResult: Sendable {
        case loaded([Instance])
        case failed(String)
        case cancelled
    }

    func updateProfile(_ patch: BotProfilePatch, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let result = try await client.updateProfileWithCompatibility(botId: bot.id, patch: patch)
            guard !Task.isCancelled else { return nil }
            guard streamAllows(.explicit) else { return nil }
            switch result {
            case let .updated(updated):
                state.apply(.bot(updated))
                return updated
            case let .updatedWithPendingAppearance(updated, fields):
                state.apply(.bot(updated))
                retainPendingAppearance(fields: fields, from: patch, for: bot.id)
                return state.bot(bot.id) ?? updated
            case let .pendingAppearance(fields):
                retainPendingAppearance(fields: fields, from: patch, for: bot.id)
                return state.bot(bot.id) ?? bot
            }
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    /// Keep character choices visible when the paired sidecar has not yet
    /// learned the newer profile fields. The override is scoped to this
    /// connection and bot, persisted by the session, and retired as soon as
    /// an authoritative response echoes either field.
    private func retainPendingAppearance(fields: Set<String>, from patch: BotProfilePatch, for botID: String) {
        var override = state.appearanceOverrides.value(for: "bot:\(botID)") ?? BotAppearanceOverride()
        if fields.contains("color"), let color = patch.color { override.color = color }
        if fields.contains("mascotShape"), let shape = patch.mascotShape { override.mascotShape = shape }
        if fields.contains("avatarCrop"), let crop = patch.avatarCrop { override.avatarCrop = crop }
        if fields.contains("avatarUrl") {
            switch patch.avatarUrl {
            case let .set(url): override.avatarUrl = url
            case .clear, nil: override.avatarUrl = nil
            }
        }
        guard streamAllows(.explicit) else { return }
        state.setLocalAppearance(override, for: "bot:\(botID)")
        persistAppearanceOverrides()
    }

    func appearanceSaveNotice(for bot: Bot) -> String? {
        guard state.appearanceOverrides.value(for: "bot:\(bot.id)") != nil else { return nil }
        return "Saved on this phone · syncs everywhere when the computer is updated"
    }

    /// Retry pending appearance writes after a completed full hydrate. This
    /// is intentionally quiet: an older sidecar can reject the same fields
    /// until it is upgraded, and that is not an actionable error on every
    /// reconnect. A successful response flows through the normal state fold,
    /// which reconciles and removes each matching local field.
    func retryPendingAppearanceOverrides() async {
        guard let client else { return }
        await retryPendingAppearanceOverrides(
            using: client,
            authority: .requiredGeneration(streamGeneration)
        )
    }

    private func retryPendingAppearanceOverrides(
        using client: CompanionClient,
        authority: StreamTransactionPolicy.Authority
    ) async {
        for (stableID, override) in state.appearanceOverrides.entries {
            guard StreamTransactionPolicy.shouldApplyAppearanceRetry(
                authority: authority,
                currentGeneration: streamGeneration
            ) else { return }
            guard stableID.hasPrefix("bot:"),
                  let botID = stableID.split(separator: ":", maxSplits: 1).last,
                  let bot = state.bot(String(botID))
            else { continue }
            let patch = BotProfilePatch(color: override.color, mascotShape: override.mascotShape)
            do {
                let result = try await client.updateProfileWithCompatibility(botId: bot.id, patch: patch)
                guard StreamTransactionPolicy.shouldApplyAppearanceRetry(
                    authority: authority,
                    currentGeneration: streamGeneration
                ) else { return }
                guard !Task.isCancelled else { return }
                switch result {
                case let .updated(updated), let .updatedWithPendingAppearance(updated, fields: _):
                    state.apply(.bot(updated))
                case .pendingAppearance:
                    break
                }
            } catch {
                // Keep the pending choice. The next foreground hydrate or
                // profile open will retry once the route is available.
            }
        }
        guard StreamTransactionPolicy.shouldApplyAppearanceRetry(
            authority: authority,
            currentGeneration: streamGeneration
        ) else { return }
        persistAppearanceOverrides()
    }

#if DEBUG
    /// Credential-free engine row so store-preview Computer screens can
    /// gate Local VM controls the same way a live catalog would.
    func storePreviewInstance(matching bot: Bot) -> Instance? {
        guard ProcessInfo.processInfo.arguments.contains("-store-preview") else { return nil }
        let instanceId = bot.modelSelection.instanceId
        let model = bot.modelSelection.model
        let payload = Data("""
        {"instanceId":"\(instanceId)","driverKind":"claudeAgent","displayName":"Preview",
         "snapshot":{"state":"available"},
         "models":{"default":"\(model)","options":[{"id":"\(model)","label":"\(model)"}]},
         "capabilities":{"computerMcp":true}}
        """.utf8)
        return try? JSONDecoder().decode(Instance.self, from: payload)
    }

    static func storePreviewProviderCatalog() -> [Instance] {
        let json = """
        [
          {
            "instanceId":"codex","driverKind":"codex","displayName":"Codex",
            "snapshot":{"state":"available"},
            "models":{"default":"gpt-5.6-sol","options":[
              {"id":"gpt-5.6-sol","label":"GPT-5.6 Sol"},
              {"id":"gpt-5.4","label":"GPT-5.4"}
            ]}
          },
          {
            "instanceId":"claude","driverKind":"claudeAgent","displayName":"Claude",
            "snapshot":{"state":"available"},
            "models":{"default":"claude-sonnet-5","options":[
              {"id":"claude-sonnet-5","label":"Claude Sonnet 5"},
              {"id":"claude-haiku-4-5","label":"Claude Haiku 4.5"}
            ]}
          },
          {
            "instanceId":"cursor","driverKind":"cursorAgent","displayName":"Cursor",
            "snapshot":{"state":"available"},
            "models":{"default":"auto","options":[
              {"id":"auto","label":"Auto"},
              {"id":"composer-2.5","label":"Composer 2.5"}
            ]}
          },
          {
            "instanceId":"openai-compat","driverKind":"openai-compat","displayName":"OpenRouter",
            "snapshot":{"state":"available"},
            "models":{"default":"meta-llama/llama-3.3-70b-instruct","options":[
              {"id":"meta-llama/llama-3.3-70b-instruct","label":"Llama 3.3 70B"}
            ]}
          },
          {
            "instanceId":"grok","driverKind":"grokAgent","displayName":"Grok",
            "snapshot":{"state":"available"},
            "models":{"default":"grok-4.6","options":[
              {"id":"grok-4.6","label":"Grok 4.6"}
            ]}
          },
          {
            "instanceId":"gemini","driverKind":"geminiAgent","displayName":"Gemini",
            "snapshot":{"state":"available"},
            "models":{"default":"gemini-3.5-flash","options":[
              {"id":"gemini-3.5-flash","label":"Gemini 3.5 Flash"}
            ]}
          }
        ]
        """
        return (try? JSONDecoder().decode([Instance].self, from: Data(json.utf8))) ?? []
    }
#endif

    func loadInstances() async -> ModelCatalogLoadResult {
        guard let client else { return .failed("This computer is offline.") }
        do {
            return .loaded(try await client.instances())
        } catch {
            return Task.isCancelled ? .cancelled : .failed(error.localizedDescription)
        }
    }

    /// Single catalog load used by chat, profile, and settings pickers.
    func loadModelCatalog(
        quietly: Bool = false,
        authority: StreamTransactionPolicy.Authority = .explicit
    ) async -> ModelCatalogLoadResult {
        guard streamAllows(authority) else { return .cancelled }
        let generation = modelCatalogGate.beginLoad()
        modelCatalogRefreshing = modelCatalogGate.refreshing

        func isCurrent() -> Bool {
            EngineSyncPolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: modelCatalogGate.generation
            )
        }

        func publish(_ result: ModelCatalogLoadResult) -> ModelCatalogLoadResult {
            guard modelCatalogGate.finishLoad(startedGeneration: generation) else { return .cancelled }
            modelCatalogRefreshing = modelCatalogGate.refreshing
            guard streamAllows(authority) else { return .cancelled }
            switch result {
            case let .loaded(instances):
                modelCatalog = instances
                modelCatalogError = nil
            case let .failed(message):
                modelCatalogError = message
                if !quietly, modelCatalog.isEmpty {
                    actionError = message
                }
            case .cancelled:
                break
            }
            return result
        }

        if engineSync == nil {
            await refreshEngineSync(quietly: true, authority: authority)
        }
        guard isCurrent(), streamAllows(authority) else { return publish(.cancelled) }

        switch EngineSyncPolicy.catalogSource(for: engineSync) {
        case .unknown:
            return publish(.failed(actionError ?? "Engine status is not available yet. Try again in a moment."))
        case let .reconstructedUnavailable(reason):
            return publish(.failed(reason))
        case .reconstructed:
            let router: VBotRouterState?
            if let existing = engineSync?.router {
                router = existing
            } else {
                router = await reconstructedRouter()
            }
            guard isCurrent(), streamAllows(authority) else { return publish(.cancelled) }
            guard let router else {
                return publish(.failed(actionError ?? "Could not load providers for the selected engine."))
            }
            return publish(.loaded(router.asInstances))
        case .advertised:
            switch await loadInstances() {
            case let .loaded(loaded):
                return publish(.loaded(loaded))
            case let .failed(message):
                return publish(.failed(message))
            case .cancelled:
                return publish(.cancelled)
            }
        }
    }

    func loadEngineSync() async -> VBotEngineSync? {
        engineSyncGeneration = EngineSyncPolicy.nextGeneration(after: engineSyncGeneration)
        let generation = engineSyncGeneration
        guard let client else { return nil }
        do {
            let loaded = try await client.engineSync()
            guard EngineSyncPolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: engineSyncGeneration
            ) else { return nil }
            engineSync = loaded
            return loaded
        } catch let APIError.status(code, _) where code == 404 {
            guard EngineSyncPolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: engineSyncGeneration
            ) else { return nil }
            engineSync = .openMausOnly
            return engineSync
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func setPrimaryEngine(_ engine: VBotPrimaryEngine) async -> VBotEngineSync? {
        engineSyncGeneration = EngineSyncPolicy.nextGeneration(after: engineSyncGeneration)
        let generation = engineSyncGeneration
        guard let client else { return nil }
        do {
            let loaded = try await client.setPrimaryEngine(engine)
            guard EngineSyncPolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: engineSyncGeneration
            ) else { return nil }
            engineSync = loaded
            return loaded
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func refreshEngineSync(quietly: Bool = false, authority: StreamTransactionPolicy.Authority = .explicit) async {
        guard streamAllows(authority) else { return }
        engineSyncGeneration = EngineSyncPolicy.nextGeneration(after: engineSyncGeneration)
        let generation = engineSyncGeneration
        guard let client else { return }
        do {
            let loaded = try await client.engineSync()
            guard EngineSyncPolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: engineSyncGeneration
            ), streamAllows(authority) else { return }
            engineSync = loaded
        } catch let APIError.status(code, _) where code == 404 {
            guard EngineSyncPolicy.shouldApply(
                startedGeneration: generation,
                currentGeneration: engineSyncGeneration
            ), streamAllows(authority) else { return }
            engineSync = .openMausOnly
        } catch {
            if !quietly, !Task.isCancelled { actionError = error.localizedDescription }
        }
    }

    func reconstructedRouter() async -> VBotRouterState? {
        guard let client else { return nil }
        do {
            return try await client.reconstructedRouter()
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func refreshReconstructedActivity(for bot: Bot, quietly: Bool = true) async {
        guard let sync = engineSync,
              sync.usesReconstructedMutations,
              sync.reconstructedMutationsReady,
              let client
        else { return }
        do {
            let activity = try await client.reconstructedActivity(botId: bot.id)
            guard !Task.isCancelled, var updated = state.bot(bot.id) else { return }
            updated.busy = activity.busy
            updated.activity = activity.activityKind == "idle" ? "idle" : "working"
            state.apply(.bot(updated))
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly, !Task.isCancelled { actionError = error.localizedDescription }
        }
    }

    func setReconstructedRouter(
        provider: String?,
        modelId: String?,
        owner: InterruptedModelWritePolicy.RouterOwner = .settings
    ) async -> VBotRouterState? {
        routerWriteOwner = owner
        routerWriteGeneration = EngineSyncPolicy.nextGeneration(after: routerWriteGeneration)
        let generation = routerWriteGeneration
        let patch = VBotRouterPatch(provider: provider, modelId: modelId)
        let router = await routerWriter.submit(key: "router", intent: patch) { patch in
            await self.sendReconstructedRouter(patch)
        }
        guard let router else { return nil }
        guard EngineSyncPolicy.shouldApply(
            startedGeneration: generation,
            currentGeneration: routerWriteGeneration
        ) else { return nil }
        if var sync = engineSync {
            sync.router = router
            engineSync = sync
        }
        return router
    }

    private func sendReconstructedRouter(_ patch: VBotRouterPatch) async -> VBotRouterState? {
        if Task.isCancelled { return nil }
        guard let client else { return nil }
        routerWriteInFlight = true
        defer { routerWriteInFlight = false }
        do {
            let router = try await client.setReconstructedRouter(patch)
            if Task.isCancelled {
                if InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true) {
                    unconfirmedRouterWrite = true
                }
                return nil
            }
            return router
        } catch {
            if Task.isCancelled || error.isCancellation {
                if InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true) {
                    unconfirmedRouterWrite = true
                }
                return nil
            }
            actionError = error.localizedDescription
            return nil
        }
    }

    private func sendReconstructed(
        _ text: String,
        toBot botId: String,
        mode: MessageDeliveryMode
    ) async throws -> MessageDeliveryReceipt {
        guard let client else { throw APIError.transport("This computer is offline.") }
        if mode == .queue {
            throw APIError.status(
                code: 409,
                message: "Grok Reconstructed does not support queued messages."
            )
        }
        return try await client.sendReconstructedTurn(
            botId: botId,
            prompt: text,
            steer: mode == .steer
        )
    }

    func invalidateModelUpdates(for botId: String) {
        let targets = InterruptedModelWritePolicy.invalidationTargets(
            botId: botId,
            mutationTarget: VBotMutationRouting.target(for: engineSync),
            inFlightRouterOwner: routerWriteOwner
        )
        for target in targets {
            switch target {
            case let .advertisedBot(id):
                modelUpdateGenerations[id] = EngineSyncPolicy.nextGeneration(
                    after: modelUpdateGenerations[id] ?? 0
                )
                if advertisedWritesInFlight.contains(id),
                   InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true) {
                    unconfirmedModelWrites.insert(id)
                }
            case .reconstructedRouter:
                routerWriteGeneration = EngineSyncPolicy.nextGeneration(after: routerWriteGeneration)
                if routerWriteInFlight,
                   InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true) {
                    unconfirmedRouterWrite = true
                }
            }
        }
        Task {
            for target in targets {
                switch target {
                case let .advertisedBot(id):
                    await modelWriter.invalidate(key: id)
                case .reconstructedRouter:
                    await routerWriter.invalidate(key: "router")
                }
            }
        }
    }

    func updateModel(_ patch: BotModelPatch, for bot: Bot) async -> Bot? {
        let generation = EngineSyncPolicy.nextGeneration(after: modelUpdateGenerations[bot.id] ?? 0)
        modelUpdateGenerations[bot.id] = generation
        let updated: Bot?
        if VBotMutationRouting.target(for: engineSync) == .grokReconstructed {
            guard let router = await setReconstructedRouter(
                provider: patch.instanceId,
                modelId: patch.model,
                owner: .bot(bot.id)
            ) else { return nil }
            var next = state.bot(bot.id) ?? bot
            next.modelSelection = ModelSelection(
                instanceId: router.selected.provider,
                model: router.selected.modelId
            )
            updated = next
        } else {
            let intent = ModelWriteIntent(bot: bot, patch: patch)
            updated = await modelWriter.submit(key: bot.id, intent: intent) { intent in
                await self.sendAdvertisedModelPatch(intent)
            }
        }
        guard let updated else { return nil }
        guard ModelSelectionPolicy.shouldApplyResponse(
            requestRevision: generation,
            currentRevision: modelUpdateGenerations[bot.id] ?? 0
        ) else { return nil }
        state.apply(.bot(updated))
        return updated
    }

    private func sendAdvertisedModelPatch(_ intent: ModelWriteIntent) async -> Bot? {
        if Task.isCancelled { return nil }
        guard let client else { return nil }
        advertisedWritesInFlight.insert(intent.bot.id)
        defer { advertisedWritesInFlight.remove(intent.bot.id) }
        do {
            let updated = try await client.updateModel(botId: intent.bot.id, patch: intent.patch)
            if Task.isCancelled {
                if InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true) {
                    unconfirmedModelWrites.insert(intent.bot.id)
                }
                return nil
            }
            return updated
        } catch {
            if Task.isCancelled || error.isCancellation {
                if InterruptedModelWritePolicy.shouldForceHydrate(inFlightWriteInterrupted: true) {
                    unconfirmedModelWrites.insert(intent.bot.id)
                }
                return nil
            }
            actionError = error.localizedDescription
            return nil
        }
    }

    private func reconcileInterruptedModelWriteIfNeeded(for chat: Chat) async -> Bool {
        let unconfirmed: Bool
        switch chat {
        case let .bot(bot):
            unconfirmed = unconfirmedModelWrites.contains(bot.id) || unconfirmedRouterWrite
        case .room:
            unconfirmed = unconfirmedRouterWrite
        }
        guard InterruptedModelWritePolicy.shouldHoldTurnUntilHydrate(unconfirmedWrite: unconfirmed) else {
            return true
        }
        do {
            let committed = try await hydrate()
            guard committed else { return false }
            if case let .bot(bot) = chat {
                unconfirmedModelWrites.remove(bot.id)
            }
            unconfirmedRouterWrite = false
            return true
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return false
        }
    }

    private func resetInterruptedModelWriteTracking() {
        routerWriteOwner = nil
        advertisedWritesInFlight.removeAll()
        routerWriteInFlight = false
        unconfirmedModelWrites.removeAll()
        unconfirmedRouterWrite = false
    }

    func updateComputerDestination(_ patch: BotComputerDestinationPatch, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateComputerDestination(botId: bot.id, patch: patch)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            if updated.computer?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "vm" {
                await refreshLocalVm(for: updated)
            }
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func updateFastMode(_ enabled: Bool, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateFastMode(botId: bot.id, patch: BotFastModePatch(fastMode: enabled))
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func uploadAvatar(_ data: Data, mime: String, for bot: Bot, crop: AvatarCrop) async -> Bot? {
        guard let client else { return nil }
        do {
            let avatarUrl = try await client.uploadAvatar(data: data, mime: mime)
            guard !Task.isCancelled else { return nil }
            let current = state.bot(bot.id) ?? bot
            return await updateProfile(
                BotProfilePatch(avatarUrl: .set(avatarUrl), avatarCrop: crop),
                for: current
            )
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func generateAvatar(prompt: String, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.generateAvatar(botId: bot.id, prompt: prompt)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func avatarData(for bot: Bot) async -> Data? {
        guard let path = bot.avatarUrl, let client else { return nil }
        let key = path as NSString
        if let cached = avatarCache.object(forKey: key) { return cached as Data }
        let generation = avatarCacheGeneration
        let fetch: (id: UUID, task: Task<Data?, Never>)
        if let pending = avatarFetches[path] {
            fetch = pending
        } else {
            let pending = (
                id: UUID(),
                task: Task<Data?, Never> { try? await client.avatar(path: path) }
            )
            avatarFetches[path] = pending
            fetch = pending
        }
        let data = await fetch.task.value
        if avatarFetches[path]?.id == fetch.id { avatarFetches.removeValue(forKey: path) }
        guard !Task.isCancelled, generation == avatarCacheGeneration, let data else { return nil }
        avatarCache.setObject(data as NSData, forKey: key, cost: data.count)
        return data
    }

    /// Circular PNG of the bot's photo, or a still of its mascot. Local
    /// banners otherwise stamp the app icon — the old OpenMaus droplet —
    /// over every agent.
    func notificationAvatarPNG(for bot: Bot?) async -> Data? {
        guard let bot else { return nil }
        if bot.displayedAvatarCrop != .mascot, let data = await avatarData(for: bot), let image = UIImage(data: data) {
            return NotificationAvatar.circularPNG(from: image)
        }
        let renderer = ImageRenderer(
            content: MausAvatar(
                color: bot.color,
                size: 96,
                state: .idle,
                shape: bot.mascotShape?.rawValue ?? "droplet",
                animated: false
            )
            .frame(width: 96, height: 96)
        )
        renderer.scale = 3
        guard let image = renderer.uiImage else { return nil }
        return NotificationAvatar.circularPNG(from: image)
    }

    private func resetAvatarCache() {
        avatarCacheGeneration += 1
        for fetch in avatarFetches.values { fetch.task.cancel() }
        avatarFetches.removeAll()
        avatarCache.removeAllObjects()
    }

    func voiceOptions() async -> [Voice] {
        guard let client else { return [] }
        do { return try await client.voices() }
        catch { actionError = error.localizedDescription; return [] }
    }

    func previewVoice(_ voiceId: String, for bot: Bot) async -> Data? {
        guard let client else { return nil }
        do { return try await client.previewVoice(text: "Hello, I'm \(bot.name).", voiceId: voiceId) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func configStatus() async -> ConfigStatus? {
        guard let client else { return nil }
        return try? await client.config()
    }

    /// Read the server-authoritative app-wide permission default. Preferences
    /// never live only on this phone.
    func permissionPolicy() async -> PermissionPolicyStatus? {
        guard let client else { return nil }
        do { return try await client.permissionPolicy() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func updatePermissionPolicy(_ mode: PermissionMode) async -> PermissionPolicyStatus? {
        guard let client else { return nil }
        do { return try await client.setPermissionPolicy(defaultMode: mode) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func approvalReviewer() async -> ApprovalReviewerStatus? {
        guard let client else { return nil }
        do { return try await client.approvalReviewer() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func updateApprovalReviewer(_ patch: ApprovalReviewerPatch) async -> ApprovalReviewerStatus? {
        guard let client else { return nil }
        do { return try await client.setApprovalReviewer(patch) }
        catch { actionError = error.localizedDescription; return nil }
    }

    /// Set an explicit per-bot override and fold the server response into the
    /// shared roster so every open view reflects it immediately.
    func updatePermissionMode(_ mode: PermissionMode?, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.setPermissionMode(botId: bot.id, mode: mode)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    // MARK: - Routines

    func loadRoutines() async -> (routines: [Routine], runs: [RoutineRun]) {
        guard let client else { return ([], []) }
        do { return try await client.routines() }
        catch { actionError = error.localizedDescription; return ([], []) }
    }

    func loadRoutineRunAvailability() async -> RoutineRunAvailability? {
        guard let client else { return nil }
        do {
            async let config = client.config()
            async let instances = client.instances()
            return try await RoutineRunAvailability(config: config, instances: instances)
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func saveRoutine(_ input: RoutineInput, id: String?) async -> Routine? {
        guard let client else { return nil }
        do {
            if let id { return try await client.updateRoutine(id: id, input: input) }
            return try await client.createRoutine(input)
        } catch { actionError = error.localizedDescription; return nil }
    }

    func setRoutineEnabled(_ routine: Routine, enabled: Bool) async -> Routine? {
        guard let client else { return nil }
        do { return try await client.setRoutineEnabled(id: routine.id, enabled: enabled) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func runRoutine(_ routine: Routine) async -> RoutineRun? {
        guard let client else { return nil }
        do { return try await client.runRoutine(id: routine.id) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func deleteRoutine(_ routine: Routine) async -> Bool {
        guard let client else { return false }
        do { try await client.deleteRoutine(id: routine.id); return true }
        catch { actionError = error.localizedDescription; return false }
    }

    // MARK: - Notification navigation

    func setAppActive(_ active: Bool) {
        NotificationCoordinator.shared.appIsActive = active
    }

    func setForegroundThread(_ threadId: String?) {
        NotificationCoordinator.shared.foregroundThreadId = threadId
        state.reconcileUnreadIndicators(visibleThreadId: threadId)
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    private func shouldSuppressNotification(for threadId: String) -> Bool {
        NotificationCoordinator.shared.appIsActive
            && NotificationCoordinator.shared.foregroundThreadId == threadId
    }

    func openNotification(_ target: NotificationTarget) async {
        guard let client else {
            // Do not carry a stale destination into a future, unrelated
            // pairing. Only a saved connection waiting for Keychain access is
            // eligible for replay.
            if restorePending {
                pendingNotification = target
                connect()
            } else {
                actionError = "Pair this phone with your computer to open that task."
            }
            return
        }
        pendingNotification = nil
        do {
            let generation = streamGeneration
            var bot = state.bot(target.botId)
            if bot == nil {
                guard let fleet = try await fetchFleet() else { return }
                let hydrate = StreamTransactionPolicy.helperHydrate(
                    startedGeneration: generation,
                    currentGeneration: streamGeneration
                )
                if hydrate.applyFleet {
                    await applyPreparedHydrate(fleet, requiredGeneration: generation)
                }
                let note = StreamTransactionPolicy.notification(
                    startedGeneration: generation,
                    currentGeneration: streamGeneration
                )
                guard note.continueNavigation else { return }
                if note.bumpAuthoritativeRevision {
                    recordHydration(resumed: false)
                }
                bot = state.bot(target.botId)
            }
            guard StreamTransactionPolicy.notification(
                startedGeneration: generation,
                currentGeneration: streamGeneration
            ).continueNavigation else { return }
            // A room's approval/question notification carries the asker bot
            // with the ROOM's thread id — open the room rather than asking
            // the bot to switch to a thread it does not own (a 404).
            if let room = state.rooms.first(where: { $0.threadId == target.threadId }) {
                notificationChat = .room(room)
                return
            }
            guard var selected = bot else { throw APIError.status(code: 404, message: "That agent no longer exists.") }
            if target.requiresTaskSwitch(activeThreadId: selected.threadId) {
                do {
                    selected = try await client.switchTask(botId: selected.id, threadId: target.threadId)
                    guard StreamTransactionPolicy.notification(
                        startedGeneration: generation,
                        currentGeneration: streamGeneration
                    ).continueNavigation else { return }
                    state.apply(.bot(selected))
                } catch {
                    // The thread may be gone (task deleted, stale payload).
                    // Landing in the bot's current chat still beats an error
                    // banner and no navigation at all.
                }
            }
            guard StreamTransactionPolicy.notification(
                startedGeneration: generation,
                currentGeneration: streamGeneration
            ).continueNavigation else { return }
            notificationChat = .bot(selected)
        } catch { actionError = error.localizedDescription }
    }

    func consumeNotificationChat() { notificationChat = nil }

    func react(to message: Message, in threadId: String, emoji: String) async {
        guard let client else { return }
        do {
            let patched = try await client.toggleReaction(threadId: threadId, messageId: message.id, emoji: emoji)
            state.apply(.messagePatch(threadId: threadId, message: patched))
            SoundEffects.playTapback()
            Haptics.selection()
        } catch {
            if !error.isCancellation {
                actionError = error.localizedDescription
                Haptics.error()
            }
        }
    }

    func edit(_ message: Message, for bot: Bot, text: String) async {
        await perform { try await $0.edit(botId: bot.id, messageId: message.id, text: text) }
    }

    func switchVersion(to message: Message, for bot: Bot) async {
        guard let client else { return }
        do {
            let leaf = try await client.setActiveBranch(botId: bot.id, messageId: message.id)
            state.apply(.thread(threadId: bot.threadId, activeLeafId: leaf))
        } catch { actionError = error.localizedDescription }
    }

    func export(threadId: String, format: String) async -> URL? {
        guard let client else { return nil }
        do {
            let exported = try await client.export(threadId: threadId, format: format)
            let name = URL(fileURLWithPath: exported.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try exported.data.write(to: url, options: .atomic)
            return url
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Connected apps

    func loadConnectorCatalog() async -> ConnectorCatalog? {
        guard let client else { return nil }
        do { return try await client.connectorCatalog() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func loadAllConnectorStatuses() async -> ConnectorStatuses? {
        guard let client else { return nil }
        do { return try await client.allConnectorStatuses() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func authorizeConnector(_ slug: String, alias: String?) async -> URL? {
        guard let client else { return nil }
        do { return try await client.authorizeConnector(slug: slug, alias: alias) }
        catch { actionError = error.localizedDescription; return nil }
    }

    /// Start OAuth for a connector request already present in this transcript.
    /// The server binds the action to the card's message and thread; the phone
    /// only supplies those ids and never receives a credential payload.
    func authorizeConnectorCard(chat: Chat, message: Message) async -> URL? {
        guard let client, let botId = connectorBotId(for: chat, message: message) else {
            actionError = "This connection card is no longer available."
            return nil
        }
        do {
            let url = try await client.authorizeConnectorCard(
                botId: botId,
                threadId: chat.threadId,
                messageId: message.id
            )
            await refreshTranscript(threadId: chat.threadId, quietly: true)
            return url
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            actionError = error.localizedDescription
        }
        return nil
    }

    /// Read the server's current OAuth state. A transcript refresh follows a
    /// terminal state so a paused card changes even when SSE was interrupted
    /// while the browser was in the foreground.
    func connectorCardStatus(chat: Chat, message: Message) async -> ConnectorCardStatusResponse? {
        guard let client, let botId = connectorBotId(for: chat, message: message) else { return nil }
        do {
            let response = try await client.connectorCardStatus(
                botId: botId,
                threadId: chat.threadId,
                messageId: message.id
            )
            let failed = response.status?.range(
                of: "failed|expired|revoked|error",
                options: [.caseInsensitive, .regularExpression]
            ) != nil
            if response.connected || failed {
                await refreshTranscript(threadId: chat.threadId, quietly: true)
            }
            return response
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            // Polling is best-effort. The card remains actionable and the
            // next stream hydrate can still deliver the authoritative state.
        }
        return nil
    }

    func resumeConnectorCard(chat: Chat, message: Message) async -> Bool {
        guard let client, let botId = connectorBotId(for: chat, message: message) else {
            actionError = "This connection card is no longer available."
            return false
        }
        do {
            _ = try await client.resumeConnectorCard(
                botId: botId,
                threadId: chat.threadId,
                messageId: message.id
            )
            await refreshTranscript(threadId: chat.threadId, quietly: true)
            return true
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            actionError = error.localizedDescription
        }
        return false
    }

    func dismissConnectorCard(chat: Chat, message: Message) async -> Bool {
        guard let client, let botId = connectorBotId(for: chat, message: message) else {
            actionError = "This connection card is no longer available."
            return false
        }
        do {
            _ = try await client.dismissConnectorCard(
                botId: botId,
                threadId: chat.threadId,
                messageId: message.id
            )
            await refreshTranscript(threadId: chat.threadId, quietly: true)
            return true
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            actionError = error.localizedDescription
        }
        return false
    }

    /// Pull the current page after a browser authorization or card action.
    /// This is deliberately a merge: it preserves any local scrollback while
    /// replacing the patched card with the server's source of truth.
    func refreshTranscript(threadId: String, quietly: Bool = false) async {
        guard let client else { return }
        do {
            let page = try await client.messages(threadId: threadId, limit: 50)
            guard !Task.isCancelled else { return }
            state.merge(page, intoThread: threadId)
            reconcileQueueReceipts(
                forThread: threadId,
                transcript: state.visibleTranscript(forThread: threadId)
            )
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly, !error.isCancellation { actionError = error.localizedDescription }
        }
    }

    private func connectorBotId(for chat: Chat, message: Message) -> String? {
        switch chat {
        case let .bot(bot): return bot.id
        case .room: return message.from?.botId
        }
    }

    func refreshNotificationAuthorization() async {
        notificationAuthorization = await NotificationCoordinator.shared.authorizationStatus()
        notificationAuthorizationResolved = true
    }

    func enableNotifications() async {
        if notificationAuthorization == .denied {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return
        }
        _ = await NotificationCoordinator.shared.requestAuthorization()
        await refreshNotificationAuthorization()
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    var notificationStatusText: String {
        switch notificationAuthorization {
        case .authorized: return "On"
        case .provisional: return "Quietly on"
        case .ephemeral: return "Temporarily on"
        case .denied: return "Off in Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async {
        guard let client else { return }
        do {
            try await body(client)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly, !error.isCancellation { actionError = error.localizedDescription }
        }
    }
}

#if DEBUG
/// Debug-only, credential-free fixtures for the computer panel. The normal
/// preview still loads the real fleet-shaped JSON; these flags only replace
/// one synthetic bot and/or inject a screen event for deterministic UI QA:
/// `-preview-computer=starting|watching|unavailable|cloud-viewer|local-vm-idle|local-vm-starting|local-vm-error`
/// and the optional `-preview-bot=<id>`.
private enum StorePreviewHarness {
    private static let validScreenPNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQ0HKBIwacHACAQwappO2xZwAAAABJRU5ErkJggg=="

    static func apply(arguments: [String], to state: inout CompanionState) {
        applyConversation(arguments: arguments, to: &state)
        applyRoster(arguments: arguments, to: &state)
        guard let argument = arguments.first(where: { $0.hasPrefix("-preview-computer=") }) else { return }
        let scenario = String(argument.dropFirst("-preview-computer=".count))
        guard let target = targetBotID(arguments: arguments, state: state),
              let index = state.bots.firstIndex(where: { $0.id == target })
        else { return }

        var bot = state.bots[index]
        switch scenario {
        case "starting":
            bot.computer = "local"
            bot.cloudBackend = nil
            bot.busy = true
            state.screens.removeValue(forKey: bot.id)
        case "watching":
            bot.computer = "local"
            bot.cloudBackend = nil
            bot.busy = true
            state.screens[bot.id] = ScreenFrame(png: validScreenPNG, mime: "image/png")
        case "unavailable":
            bot.computer = "local"
            bot.cloudBackend = nil
            bot.busy = true
            state.screens[bot.id] = ScreenFrame(png: "not-an-image", mime: "image/png")
        case "cloud-viewer":
            bot.computer = "cloud"
            bot.cloudBackend = "box"
            bot.busy = false
            state.screens.removeValue(forKey: bot.id)
        case "local-vm-idle":
            bot.computer = "vm"
            bot.cloudBackend = nil
            bot.busy = false
            state.screens.removeValue(forKey: bot.id)
        case "local-vm-starting":
            bot.computer = "vm"
            bot.cloudBackend = nil
            bot.busy = false
            state.screens.removeValue(forKey: bot.id)
        case "local-vm-error":
            bot.computer = "vm"
            bot.cloudBackend = nil
            bot.busy = false
            state.screens.removeValue(forKey: bot.id)
        default:
            return
        }
        state.bots[index] = bot
    }

    static func applyConversation(arguments: [String], to state: inout CompanionState) {
        guard arguments.contains("-preview-conversation"),
              arguments.contains("-preview-busy")
        else { return }
        guard let target = targetBotID(arguments: arguments, state: state),
              let index = state.bots.firstIndex(where: { $0.id == target })
        else { return }
        var bot = state.bots[index]
        bot.busy = true
        state.bots[index] = bot
    }

    static func applyRoster(arguments: [String], to state: inout CompanionState) {
        guard arguments.contains("-preview-single-pin") else { return }
        let target = targetBotID(arguments: arguments, state: state)
            ?? state.bots.first(where: { $0.pinned == true })?.id
            ?? state.bots.first?.id
        guard let target else { return }
        for index in state.bots.indices {
            state.bots[index].pinned = state.bots[index].id == target
        }
        for index in state.rooms.indices {
            state.rooms[index].pinned = false
        }
        resolvePendingApprovals(in: &state)
    }

    static func resolvePendingApprovals(in state: inout CompanionState) {
        for threadId in state.messages.keys {
            guard var messages = state.messages[threadId] else { continue }
            var changed = false
            for messageIndex in messages.indices {
                guard var card = messages[messageIndex].card, card.isPending else { continue }
                card.answered = card.options.first ?? "Allow"
                messages[messageIndex].card = card
                changed = true
            }
            if changed {
                state.messages[threadId] = messages
            }
        }
        for botIndex in state.bots.indices {
            let threadId = state.bots[botIndex].threadId
            if let messages = state.messages[threadId] {
                state.bots[botIndex].messages = messages
            }
        }
        for roomIndex in state.rooms.indices {
            let threadId = state.rooms[roomIndex].threadId
            if let messages = state.messages[threadId] {
                state.rooms[roomIndex].messages = messages
            }
        }
    }

    static func applyLocalVm(
        arguments: [String],
        access: inout Bool,
        accessDenied: inout Bool,
        statuses: inout [String: LocalVmStatus],
        bots: [Bot]
    ) {
        guard let argument = arguments.first(where: { $0.hasPrefix("-preview-computer=") }) else { return }
        let scenario = String(argument.dropFirst("-preview-computer=".count))
        let target = arguments.first(where: { $0.hasPrefix("-preview-bot=") })
            .map { String($0.dropFirst("-preview-bot=".count)) }
            ?? bots.first(where: { $0.computer == "vm" })?.id
            ?? bots.first(where: { $0.pinned != true })?.id
            ?? bots.first?.id
        guard let target else { return }

        switch scenario {
        case "local-vm-idle":
            access = true
            accessDenied = false
            statuses[target] = LocalVmStatus(
                mode: .perBot,
                maxInstances: 2,
                state: .missing,
                container: "missing",
                daemonUp: true,
                imageReady: true,
                desktopReady: false,
                ready: false,
                createSupported: true,
                busy: false,
                canCreate: true,
                canStop: false,
                canRecreate: false,
                problem: "Create this bot's Local VM."
            )
        case "local-vm-starting":
            access = true
            accessDenied = false
            statuses[target] = LocalVmStatus(
                mode: .perBot,
                maxInstances: 2,
                state: .running,
                container: "running",
                daemonUp: true,
                imageReady: true,
                desktopReady: false,
                ready: false,
                createSupported: true,
                busy: false,
                canCreate: false,
                canStop: true,
                canRecreate: true,
                problem: "The Local VM desktop is still starting."
            )
        case "local-vm-error":
            access = true
            accessDenied = false
            statuses[target] = LocalVmStatus(
                mode: .perBot,
                maxInstances: 2,
                state: .unavailable,
                container: "running",
                daemonUp: false,
                imageReady: true,
                desktopReady: false,
                ready: false,
                createSupported: true,
                busy: false,
                canCreate: false,
                canStop: false,
                canRecreate: true,
                problem: "The Local VM desktop is unavailable."
            )
        default:
            return
        }
    }

    private static func targetBotID(arguments: [String], state: CompanionState) -> String? {
        if let explicit = arguments.first(where: { $0.hasPrefix("-preview-bot=") }) {
            return String(explicit.dropFirst("-preview-bot=".count))
        }
        let scenario = arguments.first(where: { $0.hasPrefix("-preview-computer=") })
            .map { String($0.dropFirst("-preview-computer=".count)) }
        if scenario?.hasPrefix("local-vm-") == true {
            return state.bots.first(where: { $0.computer == "vm" })?.id
                ?? state.bots.first(where: { $0.pinned != true })?.id
                ?? state.bots.first?.id
        }
        return state.bots.first(where: { $0.pinned != true })?.id
            ?? state.bots.first?.id
    }
}
#endif

/// A chat is a bot or a room. They share a thread, which is what every
/// message, approval and page is keyed by.
enum Chat: Identifiable, Hashable {
    case bot(Bot)
    case room(Room)

    var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    /// IDs are normally server-global, but keeping the kind in UI identity
    /// prevents a bot and room with a legacy-colliding id from merging in a
    /// `ForEach` or pin-mutation gate.
    var stableID: String {
        switch self {
        case let .bot(bot): return "bot:\(bot.id)"
        case let .room(room): return "room:\(room.id)"
        }
    }

    static func == (left: Chat, right: Chat) -> Bool {
        switch (left, right) {
        case let (.bot(a), .bot(b)): return a.id == b.id
        case let (.room(a), .room(b)): return a.id == b.id
        default: return false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case let .bot(bot):
            hasher.combine(0)
            hasher.combine(bot.id)
        case let .room(room):
            hasher.combine(1)
            hasher.combine(room.id)
        }
    }

    var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    var isBot: Bool {
        if case .bot = self { return true }
        return false
    }

    var subtitle: String {
        switch self {
        case let .bot(bot): return bot.title
        case let .room(room): return "\(room.memberIds.count) bots"
        }
    }

    var unread: Bool {
        switch self {
        case let .bot(bot): return bot.unread
        case let .room(room): return room.unread
        }
    }

    var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.busyBotId != nil
        }
    }

    var pinned: Bool {
        switch self {
        case let .bot(bot): return bot.pinned ?? false
        case let .room(room): return room.pinned ?? false
        }
    }

    var color: String {
        switch self {
        case let .bot(bot): return bot.color
        case .room: return "blue"
        }
    }
}

/// A chat plus the two things a roster row shows that the record itself does
/// not carry: the preview line, and when the thread last moved. Both come out
/// of the same message — the last one in the transcript.
struct ChatSummary: Identifiable, Hashable {
    let chat: Chat
    let preview: String
    let lastActivity: Double
    let pinned: Bool

    var id: String { chat.stableID }

    init(projection: ConversationSummary, chat: Chat) {
        self.chat = chat
        self.preview = projection.preview
        self.lastActivity = projection.lastActivity
        self.pinned = projection.pinned
    }
}

extension CompanionState {
    /// Everything worth showing in the chat list, mapped to the app's chat
    /// enum after CompanionCore has applied the shared projection and order.
    var chatSummaries: [ChatSummary] {
        let chats = bots.filter { $0.hidden != true }.map(Chat.bot) + rooms.map(Chat.room)
        let chatsByID = Dictionary(uniqueKeysWithValues: chats.map { ($0.stableID, $0) })
        return conversationSummaries.compactMap { projection in
            guard let chat = chatsByID[projection.id] else { return nil }
            return ChatSummary(projection: projection, chat: chat)
        }
    }
}
