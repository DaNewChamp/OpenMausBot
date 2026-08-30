// The harness's wire types, in Swift.
//
// These mirror `server/store.ts` and the payloads in `server/index.ts`.
// There is no shared type system across the two languages, so the contract
// is pinned by fixtures instead: `Tests/CompanionCoreTests/Fixtures` holds
// real responses captured from a running server, and the decoding tests
// read them. When the server changes a payload, a test here fails.
//
// Everything the server may omit is optional, and nothing is decoded more
// strictly than it has to be — a phone that refuses to show a conversation
// because one message gained a field is worse than one that ignores it.
import Foundation

// MARK: - Messages

public struct OptionCard: Codable, Hashable, Sendable {
    public var title: String
    public var subtitle: String
    public var options: [String]
    public var answered: String?
    public var dismissed: Bool?
    /// Present when this card is a live provider ask — the thing that makes
    /// it answerable rather than historical.
    public var requestId: String?
    public var tool: String?
    /// Why auto mode stopped to ask anyway.
    public var held: String?
    /// The narrow grant "always allow" would remember, e.g. `Bash:git`.
    public var allowKey: String?

    /// A card is actionable while it is unanswered and still has a request
    /// behind it. Everything else is transcript.
    public var isPending: Bool {
        requestId != nil && answered == nil && dismissed != true
    }

    /// Permission cards carry a tool; questions do not.
    public var isPermission: Bool { tool != nil }

    /// The wire API accepts an approval behavior rather than the button's
    /// display text. Treat the one refusal as deny and every other offered
    /// permission choice as allow: providers may say "Approve", "Yes", or
    /// "Always allow", and none of those should accidentally become a deny.
    public func responseBehavior(for choice: String) -> String {
        Self.responseBehavior(for: choice, isPermission: isPermission)
    }

    /// The ID-only form is used by Live Activity buttons, which carry the
    /// card kind but not the full card payload.
    public static func responseBehavior(for choice: String, isPermission: Bool) -> String {
        guard isPermission else { return "answer" }
        return isRefusal(choice) ? "deny" : "allow"
    }

    /// Shared by all of the app's card surfaces and by Live Activities.
    public static func isRefusal(_ choice: String) -> Bool {
        choice.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare("Deny") == .orderedSame
    }

    /// A provider may include the standing grant as an option of its own.
    /// Only remember it when the server supplied the narrow grant key.
    public func shouldRememberPermission(for choice: String) -> Bool {
        guard isPermission, allowKey != nil else { return false }
        let normalized = choice.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.caseInsensitiveCompare("Always allow") == .orderedSame
    }
}

public struct ToolActivity: Codable, Hashable, Sendable {
    public var name: String
    public var ok: Bool?
    /// The same chip as a phrase a voice can read.
    public var spoken: String?
    /// Marks an error fixed by installing something, not by retrying.
    public var setup: Bool?
}

public struct Sender: Codable, Hashable, Sendable {
    public var botId: String
    public var name: String
    public var color: String
}

public struct Reaction: Codable, Hashable, Sendable {
    public var emoji: String
    public var by: String
}

public struct CommChip: Codable, Hashable, Sendable {
    public var groupId: String
    public var withBotId: String
    public var withName: String
    public var withColor: String
}

/// How a message should be delivered when its conversation is already busy.
/// `auto` preserves the server's endpoint-specific legacy policy.
public enum MessageDeliveryMode: String, Codable, Sendable {
    case auto, steer, queue
}

/// The server's acknowledgement for a message submission. Queue identifiers
/// are present only when the message was accepted behind an active turn.
public struct MessageDeliveryReceipt: Codable, Equatable, Sendable {
    public enum Disposition: String, Codable, Sendable {
        case started, steered, queued, unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public let ok: Bool
    public let disposition: Disposition
    public let queueId: String?
    public let threadId: String?

    public init(
        ok: Bool = true,
        disposition: Disposition,
        queueId: String? = nil,
        threadId: String? = nil
    ) {
        self.ok = ok
        self.disposition = disposition
        self.queueId = queueId
        self.threadId = threadId
    }

    private enum CodingKeys: String, CodingKey { case ok, disposition, queueId, threadId, queued, steered }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        queueId = try container.decodeIfPresent(String.self, forKey: .queueId)
        threadId = try container.decodeIfPresent(String.self, forKey: .threadId)
        let legacyQueued = try container.decodeIfPresent(Bool.self, forKey: .queued) == true
        let legacySteered = try container.decodeIfPresent(Bool.self, forKey: .steered) == true
        if let explicit = try container.decodeIfPresent(Disposition.self, forKey: .disposition) {
            disposition = explicit
        } else if queueId != nil || legacyQueued {
            disposition = .queued
        } else if legacySteered {
            disposition = .steered
        } else {
            // Older harnesses acknowledged a send with only {ok:true};
            // treating that as a started turn keeps a staggered companion
            // rollout usable.
            disposition = .started
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(ok, forKey: .ok)
        try container.encode(disposition, forKey: .disposition)
        try container.encodeIfPresent(queueId, forKey: .queueId)
        try container.encodeIfPresent(threadId, forKey: .threadId)
    }
}

public typealias MessageDeliveryDisposition = MessageDeliveryReceipt.Disposition

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case text, options, activity, screen, connector
        /// A kind this build has never heard of.
        ///
        /// Not decorative. `kind` is not optional, so without this a single
        /// unrecognised message fails the decode of the whole response it
        /// arrived in — the thread does not render one message oddly, it
        /// does not render. The harness gains message kinds on its own
        /// schedule and the phone is updated on the App Store's, so "newer
        /// computer than phone" is the normal state of things, not an edge
        /// case. Degrading to the text a message carries is worth more than
        /// being right about its shape.
        case unknown

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public enum Role: String, Codable, Sendable {
        case bot, user

        /// Same reasoning, and `bot` rather than a third case: an unplaceable
        /// message drawn as yours would be the phone claiming you said
        /// something you did not.
        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .bot
        }
    }

    public var id: String
    public var role: Role
    public var kind: Kind
    public var at: Double
    public var text: String?
    public var card: OptionCard?
    /// A safe, OAuth-only connected-app request. Secret cards deliberately
    /// have no model here: their unknown kind falls back without exposing a
    /// credential field to the phone.
    public var connector: ConnectorMessageData?
    public var tool: ToolActivity?
    /// The message this one follows; nil at the thread root. Two messages
    /// sharing a parent are a fork.
    public var parentId: String?
    /// Rooms: which member said this.
    public var from: Sender?
    public var reactions: [Reaction]?
    public var comm: CommChip?
    /// Identity assigned by the steer queue. Unlike the text, this remains
    /// unique when a person sends the same words more than once and lets the
    /// companion retire its local acknowledgement without guessing.
    public var queueId: String?
    /// Screen messages in the paged shape: the pixels live behind
    /// `/api/threads/:threadId/messages/:id/image` rather than inline.
    public var hasImage: Bool?
    /// Screen messages in the full shape: base64 pixels, inline.
    public var png: String?
    public var mime: String?

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

// MARK: - Bots and rooms

public struct ModelSelection: Codable, Hashable, Sendable {
    public var instanceId: String
    public var model: String
    public var effort: String?

    public init(instanceId: String, model: String, effort: String? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.effort = effort
    }
}

public struct BotTask: Codable, Hashable, Sendable {
    public var threadId: String
    public var title: String
    public var createdAt: Double
}

public struct Bot: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var title: String
    public var description: String
    public var notifications: Bool
    public var color: String
    /// The mascot silhouette selected in the character picker. Older servers
    /// omit this field; clients use the droplet default when it is absent.
    public var mascotShape: MascotShape? = nil
    /// An app-owned `/api/attachments/:name` URL. The URL is intentionally
    /// relative so every paired device fetches it from its own computer.
    public var avatarUrl: String?
    /// `mascot` ignores `avatarUrl`; the other values describe the image mask.
    public var avatarCrop: AvatarCrop?
    /// An omitted crop with a stored photo still shows the image. Only an
    /// explicit `mascot` value hides it, matching "Use mascot" on profile.
    public var displayedAvatarCrop: AvatarCrop {
        if let avatarCrop { return avatarCrop }
        return avatarUrl == nil ? .mascot : .circle
    }
    public var unread: Bool
    public var modelSelection: ModelSelection
    public var createdAt: Double
    /// Runtime activity from the paired store. Older servers omit it, so the
    /// phone falls back to `busy` when deciding whether a mascot may move.
    public var activity: String?
    public var busy: Bool?
    public var pinned: Bool?
    public var hidden: Bool?
    public var chiefOfStaff: Bool?
    public var autoApprove: Bool?
    public var fastMode: Bool?
    public var alwaysAllow: [String]?
    public var computer: String?
    /// Which cloud computer backs `computer == "cloud"`. Absent (older
    /// harnesses included) means the hosted Box; "vps" means the user's own
    /// server, which has no interactive desktop to offer a phone.
    public var cloudBackend: String?
    public var speakReplies: Bool?
    public var voice: String?
    public var mascotExpression: String?
    public var tasks: [BotTask]?
    public var messages: [Message]?
    public var activeLeafId: String?
    /// Paged responses only: there is more transcript above what you got.
    public var hasMore: Bool?
}

public enum AvatarCrop: String, Codable, CaseIterable, Hashable, Sendable {
    case mascot, circle, rounded, square

    /// The desktop may gain crop modes before this app updates. Falling back
    /// keeps the complete bot/fleet payload decodable and guarantees a safe,
    /// deterministic identity image instead of dropping the agent.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .mascot
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// The paired-safe mascot marks shown by the Grok-style character picker.
/// Unknown values fall back to the familiar droplet so a newer desktop never
/// makes an older phone drop the whole bot record.
public enum MascotShape: String, Codable, CaseIterable, Hashable, Sendable, Identifiable {
    case circle, oval, square, pill, triangle, hexagon, cloud, droplet

    public var id: String { rawValue }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .droplet
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// The shared Grok-style mascot palette. `Bot.color` stays a string so an
/// older phone can still decode a newer desktop payload; callers that need a
/// concrete swatch use `Bot.mascotColor`, which safely falls back to green.
public enum MausColor: String, Codable, CaseIterable, Hashable, Sendable, Identifiable {
    case green, blue, red, orange, purple, cyan, pink, yellow, teal, coral
    case white, brown, gray

    public var id: String { rawValue }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .green
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public typealias MascotColor = MausColor

public extension Bot {
    var mascotColor: MausColor { MausColor(rawValue: color) ?? .green }

    /// Whether the paired runtime says this bot is actively working. The
    /// activity field is authoritative when present: waiting for a person,
    /// a dead runtime, and a lost signal must not make a face move forever.
    /// `busy` remains the compatibility fallback for older harnesses.
    var isWorking: Bool {
        guard let activity = activity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !activity.isEmpty else {
            return busy == true
        }
        return activity == "working"
    }
}

public struct GroupResponder: Codable, Hashable, Sendable {
    public var kind: String
    public var botId: String?

    public init(kind: String, botId: String? = nil) {
        self.kind = kind
        self.botId = botId
    }
}

public struct Room: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var threadId: String
    public var name: String
    public var memberIds: [String]
    public var defaultResponder: GroupResponder
    public var bulletin: String
    public var unread: Bool
    public var pinned: Bool?
    public var createdAt: Double
    public var dm: Bool?
    public var busyBotId: String?
    public var messages: [Message]?
    public var hasMore: Bool?
}

// MARK: - Responses

private struct Lossy<Element: Decodable>: Decodable {
    let value: Element?

    init(from decoder: Decoder) throws {
        value = try? Element(from: decoder)
    }
}

public struct Fleet: Decodable, Sendable {
    public var bots: [Bot]
    public var groups: [Room]

    private enum CodingKeys: String, CodingKey { case bots, groups }

    public init(bots: [Bot], groups: [Room]) {
        self.bots = bots
        self.groups = groups
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bots = try container.decodeIfPresent([Lossy<Bot>].self, forKey: .bots)?.compactMap(\.value) ?? []
        groups = try container.decodeIfPresent([Lossy<Room>].self, forKey: .groups)?.compactMap(\.value) ?? []
    }
}

public struct ThreadPage: Codable, Sendable {
    public var messages: [Message]
    public var hasMore: Bool?
}

public struct SearchHit: Codable, Hashable, Identifiable, Sendable {
    public var threadId: String
    public var messageId: String
    public var at: Double
    public var role: Message.Role
    public var kind: Message.Kind
    public var snippet: String
    public var matchStart: Int
    public var matchLength: Int
    public var botId: String?
    public var groupId: String?
    public var name: String
    public var task: String?
    public var onActivePath: Bool

    public var id: String { "\(threadId):\(messageId)" }
}

public struct TranscriptExport: Sendable {
    public var data: Data
    public var filename: String
    public var contentType: String

    public init(data: Data, filename: String, contentType: String) {
        self.data = data
        self.filename = filename
        self.contentType = contentType
    }
}

public struct PairedDevice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var lastSeenAt: Double
}

public struct PairResponse: Codable, Sendable {
    public var token: String
    public var device: PairedDevice
    /// What the computer calls itself — worth showing so someone with two
    /// paired machines can tell them apart.
    public var serverName: String
    /// Every address the computer answers on, best first. Stored with the
    /// connection so the app can walk to the next one when the address it
    /// paired on stops resolving. Absent from older sidecars.
    public var hosts: [String]?
    /// Full HTTPS/HTTP routes from newer sidecars. Absent during a staggered
    /// rollout; `hosts` remains the compatibility path for older builds.
    public var endpoints: [CompanionEndpoint]?

    private enum CodingKeys: String, CodingKey {
        case token, device, serverName, hosts, endpoints
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        token = try container.decode(String.self, forKey: .token)
        device = try container.decode(PairedDevice.self, forKey: .device)
        serverName = try container.decode(String.self, forKey: .serverName)
        hosts = try container.decodeIfPresent([String].self, forKey: .hosts)
        if container.contains(.endpoints) {
            // These routes are advisory and the credential may already have
            // been redeemed. One malformed or future-kind entry must not
            // discard the valid token and legacy host fallback with it.
            endpoints = (try? container.decode([Lossy<CompanionEndpoint>].self, forKey: .endpoints))?
                .compactMap(\.value) ?? []
        } else {
            endpoints = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
        try container.encode(device, forKey: .device)
        try container.encode(serverName, forKey: .serverName)
        try container.encodeIfPresent(hosts, forKey: .hosts)
        try container.encodeIfPresent(endpoints, forKey: .endpoints)
    }
}

/// The authenticated, refreshable connection identity advertised by the
/// companion sidecar at `GET /api/companion/endpoints`.
///
/// This intentionally mirrors only the non-secret routing subset of a pair
/// response. Existing paired phones can learn that hosted access was enabled
/// later without minting another device token or scanning another QR code.
public struct CompanionConnectionMetadata: Decodable, Sendable {
    public var serverName: String
    public var hosts: [String]?
    public var endpoints: [CompanionEndpoint]

    private enum CodingKeys: String, CodingKey { case serverName, hosts, endpoints }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverName = try container.decode(String.self, forKey: .serverName)
        hosts = try container.decodeIfPresent([String].self, forKey: .hosts)

        // Endpoint metadata is a replacement snapshot, not an optional hint.
        // Keep a future malformed kind from discarding valid routes beside it,
        // but reject a response with no usable route so the caller retains its
        // last known-good snapshot.
        let decoded = try container.decode([Lossy<CompanionEndpoint>].self, forKey: .endpoints)
            .compactMap(\.value)
        let stable = decoded.enumerated().sorted {
            $0.element.priority == $1.element.priority
                ? $0.offset < $1.offset
                : $0.element.priority < $1.element.priority
        }.map(\.element)
        var seen = Set<String>()
        endpoints = stable.filter { seen.insert($0.url).inserted }.prefix(8).map { $0 }
        guard !endpoints.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .endpoints,
                in: container,
                debugDescription: "Companion endpoint metadata must contain at least one valid route."
            )
        }
    }
}

/// A freshly minted provider viewer. It is deliberately not Codable for
/// persistence: the URL is a short-lived bearer credential and belongs only
/// in memory for the browser session that requested it.
public struct CloudDesktopSession: Decodable, Sendable {
    public let url: URL

    private enum CodingKeys: String, CodingKey { case joinUrl }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try container.decode(String.self, forKey: .joinUrl)
        guard let parsed = URL(string: raw),
              parsed.scheme?.lowercased() == "https",
              parsed.host != nil
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .joinUrl,
                in: container,
                debugDescription: "Cloud desktop URL must be HTTPS"
            )
        }
        url = parsed
    }
}

public struct ProviderSnapshot: Codable, Hashable, Sendable {
    public var state: String
    public var reason: String?
    public var authenticated: Bool?
    public var version: String?

    public var isAvailable: Bool { state == "available" }
}

public struct ModelOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
}

public struct ModelCatalog: Codable, Hashable, Sendable {
    public var `default`: String
    public var options: [ModelOption]
}

public struct InstanceCapabilities: Codable, Hashable, Sendable {
    public var computerMcp: Bool?
    public var localComputerMcp: Bool?
    public var effortLevels: [String]?
}

public struct Instance: Codable, Hashable, Identifiable, Sendable {
    public var instanceId: String
    public var driverKind: String
    public var displayName: String?
    public var snapshot: ProviderSnapshot
    public var models: ModelCatalog
    public var capabilities: InstanceCapabilities? = nil

    public var id: String { instanceId }

    /// What the profile picker shows for this advertised engine.
    public var pickerTitle: String {
        let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? driverKind : name
    }

    /// Matches the desktop Computer panel: Local VM needs computer MCP on
    /// an available non-BoxAgent engine. A missing capabilities object is treated
    /// as unknown rather than denied, so an older sidecar still lets the
    /// phone send the destination patch.
    public var supportsLocalVmDestination: Bool {
        guard snapshot.state == "available" else { return false }
        if driverKind == "boxAgent" { return false }
        guard let capabilities else { return true }
        return capabilities.computerMcp == true
    }

    /// Why the profile/computer picker greys out Local VM for this engine.
    public var localVmDestinationDisabledReason: String {
        if driverKind == "boxAgent" {
            return "Cloud Box runs on ascii.dev, not a Local VM on your Mac."
        }
        if driverKind == "grokReconstructed" {
            return "Grok Reconstructed cannot use Local VM. Its Mac tools still run on the paired computer. Switch to Claude, Codex, or ACP on the profile."
        }
        if snapshot.state != "available" {
            return "\(pickerTitle) is unavailable right now. Check the engine on your Mac, then try again."
        }
        return "\(pickerTitle) cannot use Local VM. Switch to Claude, Codex, or ACP on the profile."
    }

    public func modelLabel(for modelId: String) -> String {
        models.options.first(where: { $0.id == modelId })?.label ?? modelId
    }
}

extension VBotProviderCatalog {
    public var asInstances: [Instance] {
        providers.map { provider in
            let options = provider.models.filter(\.selectable).map { ModelOption(id: $0.id, label: $0.id) }
            let selected = provider.models.first(where: { $0.current })?.id
                ?? (provider.current ? currentModelId : options.first?.id)
                ?? currentModelId
            return Instance(
                instanceId: provider.id,
                driverKind: provider.id,
                displayName: provider.label,
                snapshot: ProviderSnapshot(state: "available", reason: nil, authenticated: true, version: nil),
                models: ModelCatalog(default: selected, options: options)
            )
        }
    }
}

/// Helpers over `GET /api/instances` so the profile picker only offers
/// currently advertised catalogs, matching the paired-safe model route.
public enum AdvertisedModelCatalog {
    public static func selectableInstances(from instances: [Instance]) -> [Instance] {
        instances.filter { !$0.models.options.isEmpty }
    }

    public static func instance(id: String, in instances: [Instance]) -> Instance? {
        instances.first { $0.instanceId == id }
    }

    public static func alignedModel(instanceId: String, currentModel: String, in instances: [Instance]) -> String {
        guard let instance = instance(id: instanceId, in: instances) else { return currentModel }
        if instance.models.options.contains(where: { $0.id == currentModel }) { return currentModel }
        if instance.models.options.contains(where: { $0.id == instance.models.default }) {
            return instance.models.default
        }
        return instance.models.options.first?.id ?? currentModel
    }
}

public struct InstanceList: Codable, Sendable {
    public var instances: [Instance]
}

public enum VBotPrimaryEngine: String, Codable, CaseIterable, Sendable, Identifiable {
    case openmaus
    case grokReconstructed

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .openmaus: return "OpenMaus"
        case .grokReconstructed: return "Grok Reconstructed"
        }
    }
}

public struct VBotEngineStatus: Codable, Hashable, Sendable {
    public var id: String
    public var displayName: String
    public var state: String
    public var code: String?
    public var reason: String?
    public var version: String?

    public var isAvailable: Bool { state == "available" }
}

public struct VBotSyncedBot: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var busy: Bool?
    public var isActive: Bool?
    public var isRunning: Bool?
    public var model: String?
}

public struct VBotSyncedGroup: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var memberIds: [String]
    public var busyBotId: String?
}

public struct VBotSyncedBotList: Codable, Sendable {
    public var bots: [VBotSyncedBot]
}

public struct VBotSyncedGroupList: Codable, Sendable {
    public var groups: [VBotSyncedGroup]
}

public struct VBotModelCapabilities: Codable, Hashable, Sendable {
    public var defaultModel: String
    public var models: [ModelOption]
    public var sendPrompt: Bool
    public var images: Bool
    public var queueing: Bool
    public var steer: Bool
    public var stop: Bool?
    public var attachments: Bool

    public var canStop: Bool { stop ?? true }
}

public struct VBotEngineSync: Codable, Sendable {
    public var primaryEngine: String
    public var activeSource: String
    public var fallback: Bool
    public var fallbackCode: String?
    public var fallbackReason: String?
    public var engines: [VBotEngineStatus]
    public var bots: [VBotSyncedBot]
    public var groups: [VBotSyncedGroup]
    public var modelCapabilities: VBotModelCapabilities?
    public var providers: VBotProviderCatalog?
    public var router: VBotRouterState?

    public var selectedEngine: VBotPrimaryEngine {
        VBotPrimaryEngine(rawValue: primaryEngine) ?? .openmaus
    }

    public var servingEngine: VBotPrimaryEngine {
        VBotPrimaryEngine(rawValue: activeSource) ?? .openmaus
    }

    /// Mutations follow the selected engine. Read fallback to OpenMaus must
    /// never silently send, steer, or stop on a different engine.
    public var usesReconstructedMutations: Bool {
        selectedEngine == .grokReconstructed
    }

    public var reconstructedMutationsReady: Bool {
        selectedEngine == .grokReconstructed
            && servingEngine == .grokReconstructed
            && modelCapabilities?.sendPrompt == true
    }

    public static let openMausOnly = VBotEngineSync(
        primaryEngine: VBotPrimaryEngine.openmaus.rawValue,
        activeSource: VBotPrimaryEngine.openmaus.rawValue,
        fallback: false,
        fallbackCode: nil,
        fallbackReason: nil,
        engines: [
            VBotEngineStatus(
                id: VBotPrimaryEngine.openmaus.rawValue,
                displayName: VBotPrimaryEngine.openmaus.displayName,
                state: "available",
                code: nil,
                reason: nil,
                version: nil
            )
        ],
        bots: [],
        groups: [],
        modelCapabilities: nil,
        providers: nil,
        router: nil
    )
}

public struct VBotProviderModel: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var current: Bool
    public var selectable: Bool
}

public struct VBotProvider: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var current: Bool
    public var selectable: Bool
    public var modelSelectable: Bool
    public var models: [VBotProviderModel]
}

public struct VBotProviderCatalog: Codable, Hashable, Sendable {
    public var scope: String
    public var perBotSelection: Bool
    public var currentProvider: String
    public var currentModelId: String
    public var providers: [VBotProvider]
}

public struct VBotRouterSelection: Codable, Hashable, Sendable {
    public var provider: String
    public var modelId: String
    public var scope: String
}

public struct VBotRouterState: Codable, Hashable, Sendable {
    public var scope: String
    public var perBotSelection: Bool
    public var currentProvider: String
    public var currentModelId: String
    public var providers: [VBotProvider]
    public var selected: VBotRouterSelection

    public var asInstances: [Instance] {
        VBotProviderCatalog(
            scope: scope,
            perBotSelection: perBotSelection,
            currentProvider: currentProvider,
            currentModelId: currentModelId,
            providers: providers
        ).asInstances
    }
}

public struct VBotRouterPatch: Encodable, Sendable {
    public var provider: String?
    public var modelId: String?

    public init(provider: String? = nil, modelId: String? = nil) {
        self.provider = provider
        self.modelId = modelId
    }

    private enum CodingKeys: String, CodingKey { case provider, modelId }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(provider, forKey: .provider)
        try container.encodeIfPresent(modelId, forKey: .modelId)
    }
}

public struct VBotPromptBody: Encodable, Sendable {
    public var prompt: String
    public var clientNonce: String?

    public init(prompt: String, clientNonce: String? = nil) {
        self.prompt = prompt
        self.clientNonce = clientNonce
    }

    private enum CodingKeys: String, CodingKey { case prompt, clientNonce }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(prompt, forKey: .prompt)
        try container.encodeIfPresent(clientNonce, forKey: .clientNonce)
    }
}

public struct VBotActivity: Codable, Hashable, Sendable {
    public var botId: String
    public var busy: Bool
    public var isRunning: Bool
    public var activityKind: String
    public var hostBusy: Bool
}

public struct VBotStopResult: Codable, Hashable, Sendable {
    public var ok: Bool?
    public var botId: String
    public var stopped: Bool
}

public struct VBotEngineErrorBody: Codable, Sendable {
    public var error: String
    public var code: String?
    public var action: String?
}

public struct VBotPrimaryEnginePatch: Encodable, Sendable {
    public var primaryEngine: String

    public init(primaryEngine: VBotPrimaryEngine) {
        self.primaryEngine = primaryEngine.rawValue
    }
}

public struct ConfigFlag: Codable, Hashable, Sendable {
    public var configured: Bool
    public var apiKeyConfigured: Bool?
    public var ready: Bool?
    public var voice: String?
}

public struct Profile: Codable, Hashable, Sendable {
    public var name: String
    public var email: String
}

public struct ConfigStatus: Codable, Sendable {
    public var composio: ConfigFlag?
    public var box: ConfigFlag?
    public var tts: ConfigFlag?
    public var imageGen: ConfigFlag?
    public var profile: Profile?

    /// Whether the shared synthesis credential exists on the paired
    /// computer. The credential itself never appears in this response.
    public var isTTSConfigured: Bool {
        tts?.configured == true || tts?.apiKeyConfigured == true
    }

    /// An empty voice means there is no workspace fallback. Clients must not
    /// present that state as a usable "Workspace default" choice.
    public var hasWorkspaceDefaultVoice: Bool {
        !(tts?.voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    public func canSpeak(agentVoice: String?) -> Bool {
        let hasAgentVoice = !(agentVoice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        return isTTSConfigured && (hasAgentVoice || hasWorkspaceDefaultVoice)
    }
}

// MARK: - Agent profiles, voices, routines, and notifications

public struct BotModelPatch: Encodable, Sendable {
    public var instanceId: String
    public var model: String
    public var effort: EffortUpdate

    public enum EffortUpdate: Equatable, Sendable {
        case omitted
        case clear
        case set(String)
    }

    public init(instanceId: String, model: String, effort: EffortUpdate = .omitted) {
        self.instanceId = instanceId
        self.model = model
        self.effort = effort
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(model, forKey: .model)
        switch effort {
        case .omitted:
            break
        case .clear:
            try container.encodeNil(forKey: .effort)
        case let .set(level):
            try container.encode(level, forKey: .effort)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case instanceId, model, effort
    }
}

public struct BotFastModePatch: Encodable, Sendable {
    public let fastMode: Bool

    public init(fastMode: Bool) {
        self.fastMode = fastMode
    }
}

public struct BotComputerDestinationPatch: Encodable, Sendable {
    public var computer: String
    public var acknowledgeLocalAuto: Bool?
    public var cloudBackend: String?

    public init(computer: String, acknowledgeLocalAuto: Bool? = nil, cloudBackend: String? = nil) {
        self.computer = computer
        self.acknowledgeLocalAuto = acknowledgeLocalAuto
        self.cloudBackend = cloudBackend
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(computer, forKey: .computer)
        try container.encodeIfPresent(acknowledgeLocalAuto, forKey: .acknowledgeLocalAuto)
        try container.encodeIfPresent(cloudBackend, forKey: .cloudBackend)
    }

    private enum CodingKeys: String, CodingKey {
        case computer, acknowledgeLocalAuto, cloudBackend
    }
}

public struct ChatPinPatch: Encodable, Sendable {
    public let pinned: Bool

    public init(pinned: Bool) {
        self.pinned = pinned
    }
}

public struct GroupSetupPatch: Encodable, Sendable {
    public var bulletin: String?
    public var defaultResponder: GroupResponder?

    public init(bulletin: String? = nil, defaultResponder: GroupResponder? = nil) {
        self.bulletin = bulletin
        self.defaultResponder = defaultResponder
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(bulletin, forKey: .bulletin)
        try container.encodeIfPresent(defaultResponder, forKey: .defaultResponder)
    }

    private enum CodingKeys: String, CodingKey {
        case bulletin, defaultResponder
    }
}

public struct BotVisibilityPatch: Encodable, Sendable {
    public let hidden: Bool

    public init(hidden: Bool) {
        self.hidden = hidden
    }
}

public struct BotProfilePatch: Encodable, Sendable {
    /// `nil` means "leave the field alone". Profile actions deliberately send
    /// only the fields they own so an avatar upload cannot overwrite identity
    /// or voice values that changed on another client while the sheet was open.
    public var name: String?
    public var title: String?
    public var description: String?
    public var notifications: Bool?
    public var color: String?
    public var mascotShape: MascotShape?
    public var avatarUrl: AvatarURL?
    public var avatarCrop: AvatarCrop?
    public var voice: String?
    public var speakReplies: Bool?

    /// `avatarUrl` needs three wire states: omitted, a stored path, or JSON
    /// null to clear. A nested optional would technically represent that, but
    /// makes call sites easy to get wrong (`nil` is ambiguous at a glance).
    public enum AvatarURL: Equatable, Sendable {
        case set(String)
        case clear
    }

    public init(
        name: String? = nil,
        title: String? = nil,
        description: String? = nil,
        notifications: Bool? = nil,
        color: String? = nil,
        mascotShape: MascotShape? = nil,
        avatarUrl: AvatarURL? = nil,
        avatarCrop: AvatarCrop? = nil,
        voice: String? = nil,
        speakReplies: Bool? = nil
    ) {
        self.name = name
        self.title = title
        self.description = description
        self.notifications = notifications
        self.color = color
        self.mascotShape = mascotShape
        self.avatarUrl = avatarUrl
        self.avatarCrop = avatarCrop
        self.voice = voice
        self.speakReplies = speakReplies
    }

    private enum CodingKeys: String, CodingKey {
        case name, title, description, notifications, color, mascotShape, avatarUrl, avatarCrop, voice, speakReplies
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(name, forKey: .name)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(description, forKey: .description)
        try values.encodeIfPresent(notifications, forKey: .notifications)
        try values.encodeIfPresent(color, forKey: .color)
        try values.encodeIfPresent(mascotShape, forKey: .mascotShape)
        if let avatarUrl {
            switch avatarUrl {
            case let .set(path): try values.encode(path, forKey: .avatarUrl)
            case .clear: try values.encodeNil(forKey: .avatarUrl)
            }
        }
        try values.encodeIfPresent(avatarCrop, forKey: .avatarCrop)
        try values.encodeIfPresent(voice, forKey: .voice)
        try values.encodeIfPresent(speakReplies, forKey: .speakReplies)
    }
}

/// The result of a paired-safe profile write. A few older sidecars expose the
/// profile route but reject the newer character fields; callers may keep
/// those fields as a device-local pending override while still applying the
/// rest of the profile authoritatively.
public enum ProfileUpdateResult: Sendable {
    case updated(Bot)
    case updatedWithPendingAppearance(Bot, fields: Set<String>)
    case pendingAppearance(fields: Set<String>)
}

public struct Voice: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var description: String?
}

public struct RoutineSchedule: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case once, daily
        /// A schedule introduced by a newer desktop. It remains visible but
        /// cannot be toggled or saved until the user chooses a supported kind.
        case unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }
    public var type: Kind
    public var at: Double?
    public var time: String?
    public var weekdays: [Int]?

    public static func once(at: Date) -> Self {
        .init(type: .once, at: at.timeIntervalSince1970 * 1_000, time: nil, weekdays: nil)
    }

    public static func daily(time: String, weekdays: [Int]) -> Self {
        .init(type: .daily, at: nil, time: time, weekdays: weekdays)
    }
}

public struct Routine: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var prompt: String
    public var botId: String
    public var runOn: String
    public var enabled: Bool
    public var schedule: RoutineSchedule
    public var durationMinutes: Int
    public var nextRunAt: Double?
    public var createdAt: Double
    public var updatedAt: Double
}

public struct RoutineRun: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var routineId: String
    public var routineName: String
    public var prompt: String?
    public var durationMinutes: Int?
    public var botId: String
    public var runOn: String
    public var scheduledFor: Double
    public var status: String
    public var manual: Bool
    public var triggerSource: String?
    public var threadId: String?
    public var startedAt: Double?
    public var finishedAt: Double?
    public var output: String?
    public var error: String?
    public var createdAt: Double
    public var seenAt: Double?
}

public struct RoutineInput: Encodable, Sendable {
    public var name: String
    public var prompt: String
    public var botId: String
    public var runOn: String
    public var enabled: Bool?
    public var schedule: RoutineSchedule
    public var durationMinutes: Int

    public init(
        name: String, prompt: String, botId: String, runOn: String = "maus",
        enabled: Bool? = nil, schedule: RoutineSchedule, durationMinutes: Int = 30
    ) {
        self.name = name
        self.prompt = prompt
        self.botId = botId
        self.runOn = runOn
        self.enabled = enabled
        self.schedule = schedule
        self.durationMinutes = durationMinutes
    }
}

public enum RoutineRunLocation: String, CaseIterable, Codable, Hashable, Sendable {
    case maus
    case cloud
}

/// Desktop-equivalent run-location availability, derived only from paired-safe
/// status endpoints. Selecting Cloud VM requires both the host credential and
/// an available Box agent. An existing cloud routine remains editable without
/// silently changing where it runs if that VM is temporarily unavailable.
public struct RoutineRunAvailability: Equatable, Sendable {
    public var cloudConfigured: Bool
    public var cloudInstanceAvailable: Bool

    public init(config: ConfigStatus?, instances: [Instance]) {
        cloudConfigured = config?.box?.configured == true
        cloudInstanceAvailable = instances.contains {
            $0.driverKind == "boxAgent" && $0.snapshot.isAvailable
        }
    }

    public var cloudReady: Bool { cloudConfigured && cloudInstanceAvailable }

    public func canSelect(_ location: RoutineRunLocation, preserving current: RoutineRunLocation) -> Bool {
        location == .maus || cloudReady || current == .cloud
    }
}

public extension Routine {
    var runLocation: RoutineRunLocation {
        RoutineRunLocation(rawValue: runOn) ?? .maus
    }

    /// Mirrors the desktop `canToggleRoutine` policy. A one-time routine has
    /// no meaningful Resume action once its scheduled instant has passed.
    func canToggle(at date: Date = Date()) -> Bool {
        switch schedule.type {
        case .daily:
            true
        case .once:
            (schedule.at ?? -.infinity) > date.timeIntervalSince1970 * 1_000
        case .unknown:
            false
        }
    }
}

public struct NotificationTarget: Equatable, Sendable {
    public let botId: String
    public let threadId: String

    public init?(botId: String?, threadId: String?) {
        guard let botId, let threadId,
              !botId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !threadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        self.botId = botId
        self.threadId = threadId
    }

    public init?(payload: [String: String]) {
        self.init(botId: payload["botId"], threadId: payload["threadId"])
    }

    public func requiresTaskSwitch(activeThreadId: String) -> Bool {
        threadId != activeThreadId
    }
}

// MARK: - Connected apps

public struct ConnectorCard: Codable, Hashable, Identifiable, Sendable {
    public var slug: String
    public var label: String
    public var blurb: String
    public var logo: String?
    public var domain: String?
    public var id: String { slug }
}

public struct ConnectorAccount: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var alias: String?
    public var status: String

    /// Composio lifecycle values include both `ACTIVE` and `INACTIVE`; an
    /// exact normalized comparison avoids rendering the latter as connected.
    public var isActive: Bool {
        status.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "ACTIVE"
    }
}

public struct ConnectorStatus: Codable, Hashable, Sendable {
    public var connected: Bool
    public var pending: Bool?
    public var status: String?
    public var accounts: [ConnectorAccount]?
}

public struct ConnectorCatalog: Codable, Sendable {
    public var configured: Bool
    public var mode: String?
    public var source: String?
    public var cards: [ConnectorCard]
}

/// The transcript shape for an OAuth connect card. This is intentionally
/// separate from `ConnectorCard`, which is the marketplace/catalog shape.
/// The phone receives status and instructions, never a credential or config
/// payload. Malformed/future values decode to an unusable card so one bad
/// message cannot discard an entire fleet hydrate.
public struct ConnectorMessageData: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Hashable, Sendable {
        case required, authorizing, connected, failed, unknown

        public init(from decoder: Decoder) throws {
            let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public var slug: String
    public var label: String
    public var description: String
    public var status: Status
    public var resumeKey: String
    public var error: String?
    public var dismissed: Bool?
    public var resumed: Bool?
    /// Optional catalog metadata copied onto newer connector cards. The
    /// card remains fully usable when an older harness omits these fields.
    public var logo: String?
    public var domain: String?

    public init(
        slug: String,
        label: String,
        description: String,
        status: Status,
        resumeKey: String,
        error: String? = nil,
        dismissed: Bool? = nil,
        resumed: Bool? = nil,
        logo: String? = nil,
        domain: String? = nil
    ) {
        self.slug = slug
        self.label = label
        self.description = description
        self.status = status
        self.resumeKey = resumeKey
        self.error = error
        self.dismissed = dismissed
        self.resumed = resumed
        self.logo = logo
        self.domain = domain
    }

    private enum CodingKeys: String, CodingKey {
        case slug, label, description, status, resumeKey, error, dismissed, resumed, logo, domain
    }

    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(slug: "", label: "", description: "", status: .unknown, resumeKey: "")
            return
        }
        self.init(
            slug: (try? container.decode(String.self, forKey: .slug)) ?? "",
            label: (try? container.decode(String.self, forKey: .label)) ?? "",
            description: (try? container.decode(String.self, forKey: .description)) ?? "",
            status: (try? container.decode(Status.self, forKey: .status)) ?? .unknown,
            resumeKey: (try? container.decode(String.self, forKey: .resumeKey)) ?? "",
            error: try? container.decode(String.self, forKey: .error),
            dismissed: try? container.decode(Bool.self, forKey: .dismissed),
            resumed: try? container.decode(Bool.self, forKey: .resumed),
            logo: try? container.decode(String.self, forKey: .logo),
            domain: try? container.decode(String.self, forKey: .domain)
        )
    }

    /// The only card payload shape the native view will act on. Unknown or
    /// malformed cards remain harmless transcript data and render as text
    /// when the server supplied a fallback message.
    public var isUsable: Bool {
        Self.validComponent(slug, maxBytes: 81, allowUnderscore: true)
            && !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && label.utf8.count <= 160
            && description.utf8.count <= 2_000
            && Self.validComponent(resumeKey, maxBytes: 100, allowUnderscore: true)
            && status != .unknown
    }

    public var isConnected: Bool { status == .connected }
    public var isAuthorizing: Bool { status == .authorizing }
    public var hasFailed: Bool { status == .failed }

    /// A public logo may be shown only when it is an ordinary HTTPS image
    /// URL. Credentials, fragments and non-HTTPS resources are not fetched
    /// from a transcript-provided value.
    public var safeLogoURL: URL? {
        guard let logo else { return nil }
        return Self.safeHTTPSURL(logo, allowQuery: false)
    }

    /// Connector prose is server-authored and redacted server-side, but the
    /// phone applies a small second fence before it becomes visible. This
    /// prevents a malformed card from turning a pasted key into transcript
    /// text while preserving useful instructions.
    public var displayDescription: String {
        Self.redactCredentialLikeText(description, maxLength: 600)
    }

    /// Error details are provider-authored too. Keep them useful enough to
    /// diagnose a failed OAuth handoff without ever echoing a pasted key.
    public var displayError: String? {
        guard let error, !error.isEmpty else { return nil }
        return Self.redactCredentialLikeText(error, maxLength: 400)
    }

    private static func redactCredentialLikeText(_ value: String, maxLength: Int) -> String {
        let source = String(value.prefix(maxLength))
        guard let expression = try? NSRegularExpression(
            pattern: #"(?i)(api[_ -]?key|access[_ -]?token|secret|password|bearer)\s*[:=]\s*[^\s,;]+"#
        ) else { return source }
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        return expression.stringByReplacingMatches(in: source, range: range, withTemplate: "$1: •••")
    }

    private static func validComponent(_ value: String, maxBytes: Int, allowUnderscore: Bool) -> Bool {
        guard !value.isEmpty, value.utf8.count <= maxBytes else { return false }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) ||
                (97...122).contains(byte) || byte == 45 || (allowUnderscore && byte == 95)
        }
    }

    private static func safeHTTPSURL(_ raw: String, allowQuery: Bool) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 2_048,
              !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }),
              let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.fragment == nil,
              components.port == nil || components.port == 443,
              allowQuery || components.query == nil,
              let url = components.url
        else { return nil }
        return url
    }
}

public struct ConnectorStatuses: Codable, Sendable {
    public var configured: Bool
    public var services: [String: ConnectorStatus]
}

/// The harness's error body. Every non-2xx response carries one.
public struct APIErrorBody: Codable, Sendable {
    public var error: String
    public var code: String?
    public var action: String?
}

/// One frame of a bot's computer, as it arrives on the stream.
public struct ScreenFrame: Hashable, Sendable {
    public var png: String
    public var mime: String

    public init(png: String, mime: String) {
        self.png = png
        self.mime = mime
    }

    /// Decoded pixels, or nil if the base64 was not what it claimed to be.
    /// Returning nil rather than throwing keeps the caller a view.
    public var data: Data? { Data(base64Encoded: png) }

    /// Harness Local VM captures arrive as a data URL. SSE frames are raw
    /// base64. Both become a `ScreenFrame` the Computer panel can draw.
    public static func fromCapture(_ image: String, mime: String = "image/png") -> ScreenFrame? {
        let trimmed = image.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("data:"),
           let comma = trimmed.firstIndex(of: ",") {
            let meta = trimmed[trimmed.index(trimmed.startIndex, offsetBy: 5)..<comma]
            let payload = String(trimmed[trimmed.index(after: comma)...])
            let parsedMime = meta.split(separator: ";").first.map(String.init) ?? mime
            guard !payload.isEmpty else { return nil }
            return ScreenFrame(png: payload, mime: parsedMime)
        }
        return ScreenFrame(png: trimmed, mime: mime)
    }
}

/// The phone-safe projection returned by a paired companion for a bot's
/// Mac-hosted Local VM. Host paths, image identifiers, viewer URLs, ports and
/// setup commands intentionally have no representation here.
public struct LocalVmStatus: Codable, Equatable, Sendable {
    public enum IsolationMode: String, Codable, Sendable {
        case shared, perBot = "per-bot", unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public enum State: String, Codable, Sendable {
        case ready, running, stopped, missing, unavailable, unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: raw) ?? .unknown
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public var mode: IsolationMode
    public var maxInstances: Int
    public var state: State
    public var container: String
    public var daemonUp: Bool
    public var imageReady: Bool
    public var desktopReady: Bool
    public var ready: Bool
    public var createSupported: Bool
    public var busy: Bool
    public var canCreate: Bool
    public var canStop: Bool
    public var canRecreate: Bool
    public var problem: String?

    private enum CodingKeys: String, CodingKey {
        case mode
        case maxInstances = "max_instances"
        case state, container
        case daemonUp = "daemon_up"
        case imageReady = "image_ready"
        case desktopReady = "desktop_ready"
        case ready
        case createSupported = "create_supported"
        case busy
        case canCreate = "can_create"
        case canStop = "can_stop"
        case canRecreate = "can_recreate"
        case problem
    }

    public init(
        mode: IsolationMode,
        maxInstances: Int,
        state: State,
        container: String,
        daemonUp: Bool,
        imageReady: Bool,
        desktopReady: Bool,
        ready: Bool,
        createSupported: Bool,
        busy: Bool,
        canCreate: Bool,
        canStop: Bool,
        canRecreate: Bool,
        problem: String?
    ) {
        self.mode = mode
        self.maxInstances = maxInstances
        self.state = state
        self.container = container
        self.daemonUp = daemonUp
        self.imageReady = imageReady
        self.desktopReady = desktopReady
        self.ready = ready
        self.createSupported = createSupported
        self.busy = busy
        self.canCreate = canCreate
        self.canStop = canStop
        self.canRecreate = canRecreate
        self.problem = problem
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decodeIfPresent(IsolationMode.self, forKey: .mode) ?? .unknown
        maxInstances = try container.decodeIfPresent(Int.self, forKey: .maxInstances) ?? 0
        state = try container.decodeIfPresent(State.self, forKey: .state) ?? .unknown
        self.container = try container.decodeIfPresent(String.self, forKey: .container) ?? "unknown"
        daemonUp = try container.decodeIfPresent(Bool.self, forKey: .daemonUp) ?? false
        imageReady = try container.decodeIfPresent(Bool.self, forKey: .imageReady) ?? false
        desktopReady = try container.decodeIfPresent(Bool.self, forKey: .desktopReady) ?? false
        ready = try container.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        createSupported = try container.decodeIfPresent(Bool.self, forKey: .createSupported) ?? false
        busy = try container.decodeIfPresent(Bool.self, forKey: .busy) ?? false
        canCreate = try container.decodeIfPresent(Bool.self, forKey: .canCreate) ?? false
        canStop = try container.decodeIfPresent(Bool.self, forKey: .canStop) ?? false
        canRecreate = try container.decodeIfPresent(Bool.self, forKey: .canRecreate) ?? false
        problem = try container.decodeIfPresent(String.self, forKey: .problem)
    }
}

/// Watch-only Local VM desktop capture. The harness returns a data URL;
/// `ScreenFrame.fromCapture` turns it into pixels the Computer panel can draw.
public struct LocalVmScreenshot: Codable, Equatable, Sendable {
    public var image: String

    public init(image: String) {
        self.image = image
    }
}

/// A proxied noVNC viewer path minted for this bot's ready Local VM.
/// Deliberately `Decodable` only — the path carries a one-time ticket and
/// must not be persisted on the phone.
public struct LocalVmViewerSession: Decodable, Sendable {
    public var viewerPath: String
    public var ready: Bool

    public init(viewerPath: String, ready: Bool) {
        self.viewerPath = viewerPath
        self.ready = ready
    }
}

/// Result of a bounded phone input action on a Local VM desktop.
public struct LocalVmInputResult: Decodable, Equatable, Sendable {
    public var text: String
    public var isError: Bool

    public init(text: String, isError: Bool) {
        self.text = text
        self.isError = isError
    }
}

/// `POST /api/bots` — the harness answers with the bot it made.
public struct CreatedBot: Codable, Sendable {
    public var bot: Bot
}

/// `POST /api/groups` — the harness answers with the room it made.
public struct CreatedRoom: Codable, Sendable {
    public var group: Room
}

public struct ConnectorCardStatusResponse: Codable, Sendable {
    public var connected: Bool
    public var pending: Bool?
    public var status: String?
}

public struct ConnectorCardActionResponse: Codable, Sendable {
    public var resumed: Bool?
    public var dismissed: Bool?
}

/// A URL returned by a server-side connector authorization route. OAuth
/// links may carry state in their query, but must be HTTPS and cannot smuggle
/// credentials, a fragment, or a nonstandard port into an external browser.
public enum ConnectorAuthorizationURL {
    public static func parse(_ raw: String) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 2_048,
              !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }),
              let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.fragment == nil,
              components.port == nil || components.port == 443,
              let url = components.url
        else { return nil }
        return url
    }
}

struct RoomResponse: Codable, Sendable {
    var group: Room
}

struct SearchResponse: Codable, Sendable {
    var hits: [SearchHit]
}

struct MessageResponse: Codable, Sendable {
    var message: Message
}

struct ActiveBranchResponse: Codable, Sendable {
    var activeLeafId: String
}

struct BotResponse: Codable, Sendable {
    var bot: Bot
}
struct VoiceListResponse: Codable, Sendable {
    var voices: [Voice]
    var error: String?
}

struct AttachmentResponse: Codable, Sendable {
    var path: String
    var mime: String
    var bytes: Int
}

struct GeneratedAvatarResponse: Codable, Sendable {
    var avatarUrl: String
    var bot: Bot
}

struct RoutinesResponse: Codable, Sendable {
    var routines: [Routine]
    var runs: [RoutineRun]
}

struct RoutineResponse: Codable, Sendable { var routine: Routine }
struct RoutineRunResponse: Codable, Sendable { var run: RoutineRun }

struct ConnectorAuthorizationResponse: Codable, Sendable {
    var url: String
}
