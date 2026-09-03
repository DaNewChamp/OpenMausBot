// Where the chat's preferences are stored.
//
// `@AppStorage` rather than an observable object on purpose: the settings
// screen writes these and the chat reads them, and AppStorage already keeps
// both in step through UserDefaults. One place for the key strings is the
// only thing a shared type is needed for.
import Foundation
import SwiftUI
import CompanionCore

enum PrefKey {
    static let accountAvatarSymbol = "companion.prefs.accountAvatarSymbol"
    static let islandIntro = "companion.prefs.islandIntro"
    static let islandSeen = "companion.prefs.islandSeen"
    static let activityDetail = "companion.prefs.activityDetail"
    static let activityDetailOverrides = "companion.prefs.activityDetailOverrides"
    static let quickReplies = "companion.prefs.quickReplies"
    static let voiceIsland = "companion.prefs.voiceIsland"
}

struct ActivityDetailOverridePicker: View {
    let threadId: String

    @AppStorage(PrefKey.activityDetail) private var globalDetail = ActivityDetail.reduced.rawValue
    @AppStorage(PrefKey.activityDetailOverrides) private var overrides = "{}"

    private var globalStored: ActivityDetail {
        ActivityDetail(rawValue: globalDetail) ?? .reduced
    }

    private var overrideStored: ActivityDetail? {
        ActivityDetailOverrides.detail(for: threadId, in: overrides)
    }

    private var usesGlobal: Binding<Bool> {
        Binding(
            get: { ActivityDetailTogglePolicy.usesGlobalSetting(for: threadId, in: overrides) },
            set: { useGlobal in
                if useGlobal {
                    overrides = ActivityDetailOverrides.setting(nil, for: threadId, in: overrides)
                } else {
                    let show = ActivityDetailTogglePolicy.perBotShowsToolActivity(
                        override: overrideStored,
                        global: globalStored
                    )
                    overrides = ActivityDetailOverrides.setting(
                        ActivityDetailTogglePolicy.perBotStoredValue(
                            useGlobal: false,
                            showToolActivity: show,
                            previous: overrideStored
                        ),
                        for: threadId,
                        in: overrides
                    )
                }
            }
        )
    }

    private var showToolActivity: Binding<Bool> {
        Binding(
            get: {
                ActivityDetailTogglePolicy.perBotShowsToolActivity(
                    override: overrideStored,
                    global: globalStored
                )
            },
            set: { show in
                overrides = ActivityDetailOverrides.setting(
                    ActivityDetailTogglePolicy.perBotStoredValue(
                        useGlobal: false,
                        showToolActivity: show,
                        previous: overrideStored
                    ),
                    for: threadId,
                    in: overrides
                )
            }
        )
    }

    private var effectiveDetail: ActivityDetail {
        overrideStored ?? globalStored
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tool activity")
                .font(.body)
            Toggle("Use global setting", isOn: usesGlobal)
            if !usesGlobal.wrappedValue {
                Toggle("Show tool activity", isOn: showToolActivity)
            }
            Text(usesGlobal.wrappedValue
                ? "Using global: \(effectiveDetail == .full ? ActivityDetail.reduced.label : effectiveDetail.label)."
                : (effectiveDetail == .full ? ActivityDetail.reduced.caption : effectiveDetail.caption))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// The set of chats whose island intro has already played.
///
/// Stored as JSON in the same defaults as everything else rather than in its
/// own store: it is a handful of ids, and a chat that loses its entry simply
/// plays its intro once more.
enum IslandSeen {
    static func contains(_ id: String, in json: String) -> Bool {
        decode(json).contains(id)
    }

    static func adding(_ id: String, to json: String) -> String {
        var seen = decode(json)
        guard seen.insert(id).inserted else { return json }
        guard let data = try? JSONEncoder().encode(seen.sorted()) else { return json }
        return String(decoding: data, as: UTF8.self)
    }

    private static func decode(_ json: String) -> Set<String> {
        guard let data = json.data(using: .utf8),
              let list = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return Set(list)
    }
}
