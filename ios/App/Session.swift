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
    /// Advances only after the server has replaced local state with a full
    /// fleet hydrate. Resumed SSE connections leave it unchanged so views do
    /// not mistake a reconnect for an authoritative refresh.
    @Published private(set) var authoritativeHydrationRevision = 0
    @Published private(set) var connection: Connection?
    @Published private(set) var status: Status = .unpaired
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?
    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// Distinguishes a real `.notDetermined` result from the in-memory value
    /// used while notification settings are still loading at launch.
    @Published private(set) var notificationAuthorizationResolved = false
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?

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
    /// One lifecycle action per bot at a time. Keeping this in the session
    /// prevents repeated taps from racing the server-side lease/capacity guard.
    @Published private(set) var pendingLocalVmActions: Set<String> = []
    /// Companion-safe projection of the selected desktop engine. Mutations
    /// follow `primaryEngine`; OpenMaus roster fallback is read-only.
    @Published private(set) var engineSync: VBotEngineSync?

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

    private static let connectionKey = "companion.connection"
    private static let pinnedOverridesKey = "companion.pinned-overrides"
    private static let appearanceOverridesBaseKey = "companion.appearance-overrides"

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
            connection = Connection(name: "Preview Mac", host: "preview.tailnet.ts.net", port: 8810)
            state.hydrate(fleet)
            StorePreviewHarness.apply(arguments: ProcessInfo.processInfo.arguments, to: &state)
            recordHydration(resumed: false)
            status = .live
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
        guard let data = UserDefaults.standard.data(forKey: Self.connectionKey),
              let saved = try? JSONDecoder().decode(Connection.self, from: data)
        else { return }

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
        guard let stored else { return } // no token: genuinely not paired

        connection = saved
        state.appearanceOverrides = Self.loadAppearanceOverrides(for: saved.id)
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

        try Keychain.save(paired.token, for: stored.id)
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
            UserDefaults.standard.set(
                try? JSONEncoder().encode(stored),
                forKey: Self.connectionKey
            )
        }

        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .pairingSucceeded
        )
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
        self.engineSync = nil
        localVmStatuses.removeAll()
        localVmAccess = false
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
        guard CompanionPairingInvitePolicy.allowsIncomingInvite(
            hasConnection: connection != nil,
            pairingStateIsUnpaired: status == .unpaired
        ) else {
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
    }

    func consumePairingInvite() {
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .consumed
        )
    }

    func signOut() {
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
        rotation = CandidateRotation(hosts: [])
        state = CompanionState()
        localVmStatuses.removeAll()
        localVmAccess = false
        pendingLocalVmActions.removeAll()
        resetAvatarCache()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
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
        guard client != nil, streamTask == nil else { return }
        reconnectDelay = 0
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run()
            guard self.streamGeneration == generation else { return }
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
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        endLinger()
    }

    private var lingerTask: UIBackgroundTaskIdentifier = .invalid

    /// Leaving the screen: keep the stream alive for the grace period iOS
    /// allows (~30 s) rather than cutting it at once, so an approval that
    /// lands right after you swipe home still reaches the Live Activity and
    /// the island. After that, iOS suspends us anyway; disconnect cleanly so
    /// the cursor is written down at a known point.
    func linger() {
        guard streamTask != nil, lingerTask == .invalid else { disconnect(); return }
        lingerTask = UIApplication.shared.beginBackgroundTask(withName: "companion.linger") { [weak self] in
            // time is up before our own timer — the system wants us gone now
            self?.disconnect()
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard let self, self.lingerTask != .invalid else { return }
            self.disconnect()
        }
    }

    private func endLinger() {
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    private func run() async {
        while !Task.isCancelled {
            guard let client else { return }
            status = .connecting
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
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds: if
                        // the request dies halfway through replay/hydration,
                        // reconnecting must still ask for the missing gap.
                        if !resumed {
                            try await hydrate()
                            state.resetCursor(cursor)
                            recordHydration(resumed: resumed)
                        }
                        status = .live
                        // Remember what actually carried the stream for
                        // display and legacy ordering. Typed routes retain
                        // their explicit security priority next launch.
                        rememberWorkingRoute()
                        refreshConnectionMetadata(using: client)
                        continue
                    }
                    let previousOverrides = state.pinnedOverrides
                    let previousAppearanceOverrides = state.appearanceOverrides
                    state.apply(frame)
                    if state.pinnedOverrides != previousOverrides { persistPinnedOverrides() }
                    if state.appearanceOverrides != previousAppearanceOverrides { persistAppearanceOverrides() }
                    if case let .notify(notification) = frame.frame {
                        NotificationCoordinator.shared.deliver(notification, sequence: frame.seq)
                    }
                    NotificationCoordinator.shared.setBadge(state.unreadCount)
                    state.advance(to: frame.seq)
                }
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                status = .offline("Lost the connection.")
            } catch let error as APIError where error.isUnauthorized {
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if Task.isCancelled || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                status = .offline(failureMessage(for: error))
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s. A phone that woke on a network which is
            // not the laptop's should not hammer it.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
        }
    }

    private func hydrate() async throws {
        guard let client else { return }
        let fleet = try await client.fleet(messages: 50)
        log.info("hydrated \(fleet.bots.count, privacy: .public) bots, \(fleet.groups.count, privacy: .public) rooms")
        let previousAppearanceOverrides = state.appearanceOverrides
        state.hydrate(fleet)
        persistPinnedOverrides()
        if state.appearanceOverrides != previousAppearanceOverrides { persistAppearanceOverrides() }
        await retryPendingAppearanceOverrides(using: client)
        NotificationCoordinator.shared.setBadge(state.unreadCount)
        await refreshEngineSync(quietly: true)
    }

    private var hydrationRevision = HydrationRevision()

    private func recordHydration(resumed: Bool) {
        authoritativeHydrationRevision = hydrationRevision.record(resumed: resumed)
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
            next = candidate.displayAddress
            log.info("advancing to companion route \(candidate.url, privacy: .public)")
        }
        if let urlError = error as? URLError {
            return ConnectionAdvice.message(
                for: urlError.code,
                host: failed?.displayAddress ?? connection.host,
                port: failed?.port ?? connection.port,
                tryingNext: next
            )
        }
        if let apiError = error as? APIError,
           case let .status(code, _) = apiError,
           ConnectionAdvice.shouldTryAnotherRoute(after: error) {
            return ConnectionAdvice.message(
                forGatewayStatus: code,
                host: failed?.displayAddress ?? connection.host,
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
        endpointRefreshTask?.cancel()
        endpointRefreshTask = Task { [weak self] in
            do {
                let metadata = try await sourceClient.connectionMetadata()
                try Task.checkCancellation()
                guard let self,
                      self.connection?.id == connectionID,
                      self.client?.connection.baseURL == sourceClient.connection.baseURL,
                      var updated = self.connection
                else { return }

                updated.reconcile(metadata)
                self.connection = updated
                UserDefaults.standard.set(
                    try? JSONEncoder().encode(updated),
                    forKey: Self.connectionKey
                )

                // Keep the currently live route first until this stream ends.
                // CandidateRotation applies the same no-downgrade policy used
                // by pairing, while the saved connection uses advertised
                // security priorities on the next launch.
                let liveRoutes = workingEndpoint.map { route in
                    [route] + updated.orderedEndpoints.filter { $0.url != route.url }
                } ?? updated.orderedEndpoints
                self.rotation = CandidateRotation(endpoints: liveRoutes)
                log.info("refreshed \(metadata.endpoints.count, privacy: .public) companion routes")
            } catch is CancellationError {
                return
            } catch {
                log.debug("endpoint refresh unavailable: \(error.localizedDescription, privacy: .public)")
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

    @discardableResult
    func send(
        _ text: String,
        to chat: Chat,
        mode: MessageDeliveryMode = .auto
    ) async -> MessageDeliveryReceipt? {
        guard let client else { return nil }
        do {
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
        } catch let error as APIError {
            if case let .status(code, message) = error,
               code == 404,
               message == "no route: POST /api/attachments" {
                let unavailable = APIError.transport(
                    "This computer does not support image attachments yet. Update V Bot on the computer."
                )
                if !Task.isCancelled { actionError = unavailable.localizedDescription }
                throw unavailable
            }
            if !Task.isCancelled { actionError = error.localizedDescription }
            throw error
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
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
            if !Task.isCancelled {
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
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            return try await client.cloudDesktop(botId: bot.id).url
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
            localVmStatuses[bot.id] = snapshot
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            localVmAccess = false
            localVmStatuses.removeAll()
        } catch let error as APIError {
            if case let .status(code, _) = error, code == 403 || code == 404 {
                localVmAccess = false
                localVmStatuses.removeValue(forKey: bot.id)
            } else if !Task.isCancelled {
                actionError = error.localizedDescription
            }
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
        }
    }

    func localVmStatus(for bot: Bot) -> LocalVmStatus? {
        localVmStatuses[bot.id]
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
            localVmStatuses[bot.id] = next
            return next
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            localVmAccess = false
            localVmStatuses.removeAll()
        } catch let error as APIError {
            if case let .status(code, _) = error, code == 403 || code == 404 {
                localVmAccess = false
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
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            state.prepend(page, toThread: threadId)
        } catch {
            actionError = error.localizedDescription
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
                focusedMessageId = hit.messageId
                return state.bot(bot.id).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               let room = state.rooms.first(where: { $0.id == groupId }) {
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
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
        await retryPendingAppearanceOverrides(using: client)
    }

    private func retryPendingAppearanceOverrides(using client: CompanionClient) async {
        for (stableID, override) in state.appearanceOverrides.entries {
            guard stableID.hasPrefix("bot:"),
                  let botID = stableID.split(separator: ":", maxSplits: 1).last,
                  let bot = state.bot(String(botID))
            else { continue }
            let patch = BotProfilePatch(color: override.color, mascotShape: override.mascotShape)
            do {
                let result = try await client.updateProfileWithCompatibility(botId: bot.id, patch: patch)
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
        persistAppearanceOverrides()
    }

    func loadInstances() async -> ModelCatalogLoadResult {
        guard let client else { return .failed("This computer is offline.") }
        do {
            return .loaded(try await client.instances())
        } catch {
            return Task.isCancelled ? .cancelled : .failed(error.localizedDescription)
        }
    }

    func loadEngineSync() async -> VBotEngineSync? {
        guard let client else { return nil }
        do {
            let loaded = try await client.engineSync()
            engineSync = loaded
            return loaded
        } catch let APIError.status(code, _) where code == 404 {
            engineSync = .openMausOnly
            return engineSync
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func setPrimaryEngine(_ engine: VBotPrimaryEngine) async -> VBotEngineSync? {
        guard let client else { return nil }
        do {
            let loaded = try await client.setPrimaryEngine(engine)
            engineSync = loaded
            return loaded
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func refreshEngineSync(quietly: Bool = false) async {
        guard let client else { return }
        do {
            engineSync = try await client.engineSync()
        } catch let APIError.status(code, _) where code == 404 {
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

    func setReconstructedRouter(provider: String?, modelId: String?) async -> VBotRouterState? {
        guard let client else { return nil }
        do {
            let router = try await client.setReconstructedRouter(VBotRouterPatch(provider: provider, modelId: modelId))
            if var sync = engineSync {
                sync.router = router
                engineSync = sync
            }
            return router
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
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

    func updateModel(_ patch: BotModelPatch, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            if VBotMutationRouting.target(for: engineSync) == .grokReconstructed {
                let router = try await client.setReconstructedRouter(
                    VBotRouterPatch(provider: patch.instanceId, modelId: patch.model)
                )
                guard !Task.isCancelled else { return nil }
                var updated = state.bot(bot.id) ?? bot
                updated.modelSelection = ModelSelection(
                    instanceId: router.selected.provider,
                    model: router.selected.modelId
                )
                state.apply(.bot(updated))
                return updated
            }
            let updated = try await client.updateModel(botId: bot.id, patch: patch)
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
            var bot = state.bot(target.botId)
            if bot == nil {
                let fleet = try await client.fleet(messages: 50)
                state.hydrate(fleet)
                recordHydration(resumed: false)
                bot = state.bot(target.botId)
            }
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
                    state.apply(.bot(selected))
                } catch {
                    // The thread may be gone (task deleted, stale payload).
                    // Landing in the bot's current chat still beats an error
                    // banner and no navigation at all.
                }
            }
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
            actionError = error.localizedDescription
            Haptics.error()
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
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly { actionError = error.localizedDescription }
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
            if !quietly { actionError = error.localizedDescription }
        }
    }
}

#if DEBUG
/// Debug-only, credential-free fixtures for the computer panel. The normal
/// preview still loads the real fleet-shaped JSON; these flags only replace
/// one synthetic bot and/or inject a screen event for deterministic UI QA:
/// `-preview-computer=starting|watching|unavailable|cloud-viewer` and the
/// optional `-preview-bot=<id>`.
private enum StorePreviewHarness {
    private static let validScreenPNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQ0HKBIwacHACAQwappO2xZwAAAABJRU5ErkJggg=="

    static func apply(arguments: [String], to state: inout CompanionState) {
        guard let argument = arguments.first(where: { $0.hasPrefix("-preview-computer=") }) else { return }
        let scenario = String(argument.dropFirst("-preview-computer=".count))
        let target = arguments.first(where: { $0.hasPrefix("-preview-bot=") })
            .map { String($0.dropFirst("-preview-bot=".count)) }
            ?? state.bots.first(where: { $0.pinned != true })?.id
            ?? state.bots.first?.id
        guard let target, let index = state.bots.firstIndex(where: { $0.id == target }) else { return }

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
        default:
            return
        }
        state.bots[index] = bot
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
