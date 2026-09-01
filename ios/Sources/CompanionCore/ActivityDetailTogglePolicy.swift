import Foundation

/// Maps the legacy three-level activity detail preference onto simple on/off
/// toggles while keeping stored `full` values until the user changes them.
public enum ActivityDetailTogglePolicy: Sendable {
    public static func globalShowsToolActivity(_ stored: ActivityDetail) -> Bool {
        stored != .hidden
    }

    public static func globalStoredValue(showToolActivity: Bool) -> ActivityDetail {
        showToolActivity ? .reduced : .hidden
    }

    public static func globalStoredValue(showToolActivity: Bool, previous: ActivityDetail) -> ActivityDetail {
        guard showToolActivity else { return .hidden }
        return previous == .full ? .reduced : .reduced
    }

    public static func storedValuePreservingLegacyFull(
        showToolActivity: Bool,
        previous: ActivityDetail,
        userChanged: Bool = false
    ) -> ActivityDetail {
        guard showToolActivity else { return .hidden }
        if previous == .full, !userChanged { return .full }
        return .reduced
    }

    public static func usesGlobalSetting(for threadId: String, in json: String) -> Bool {
        ActivityDetailOverrides.detail(for: threadId, in: json) == nil
    }

    public static func perBotShowsToolActivity(override: ActivityDetail?, global: ActivityDetail) -> Bool {
        let detail = override ?? global
        return detail != .hidden
    }

    public static func perBotStoredValue(
        useGlobal: Bool,
        showToolActivity: Bool,
        previous: ActivityDetail?
    ) -> ActivityDetail? {
        guard !useGlobal else { return nil }
        return showToolActivity ? .reduced : .hidden
    }
}
