import Foundation

/// The safe, provider-neutral projection used by the transcript card.
///
/// This type deliberately does not know which engine produced the metadata or
/// which repository hosts a pull request. It only exposes values the hub sent,
/// after local validation of the two URLs that can leave the app.
public struct WorkCardPresentation: Hashable, Sendable {
    public let title: String?
    public let status: String?
    public let branch: String?
    public let prNumber: Int?
    public let filesChanged: Int?
    public let additions: Int?
    public let deletions: Int?
    public let pullRequestURL: URL?
    public let cursorURL: URL?
    public let canOpenCursor: Bool

    public init(work: WorkCard?, canOpenCursor: Bool = false) {
        let title = Self.normalized(work?.title)
        let status = Self.normalized(work?.status)
        let branch = Self.normalized(work?.branch)
        self.title = title
        self.status = status
        self.branch = branch
        self.prNumber = Self.nonNegative(work?.prNumber)
        self.filesChanged = Self.nonNegative(work?.filesChanged)
        self.additions = Self.nonNegative(work?.additions)
        self.deletions = Self.nonNegative(work?.deletions)
        self.pullRequestURL = Self.validatedPRURL(work?.prURL)
        self.cursorURL = Self.validatedCursorURL(work?.cursorURL)
        self.canOpenCursor = canOpenCursor
    }

    public init(message: Message, canOpenCursor: Bool = false) {
        self.init(work: message.work, canOpenCursor: canOpenCursor)
    }

    /// A card needs at least one displayable value. An invalid URL by itself
    /// cannot turn an ordinary message into a blank card.
    public var isRenderable: Bool {
        title != nil || status != nil || branch != nil || prNumber != nil ||
            filesChanged != nil || additions != nil || deletions != nil ||
            pullRequestURL != nil || cursorURL != nil
    }

    public var showsViewPR: Bool { pullRequestURL != nil }

    public var showsOpenInCursor: Bool {
        cursorURL != nil && canOpenCursor
    }

    /// The URL that an action may open. Keeping this separate from the
    /// validated deep link makes the `canOpenURL` gate impossible to forget in
    /// the view layer.
    public var openInCursorURL: URL? {
        showsOpenInCursor ? cursorURL : nil
    }

    public static func validatedPRURL(_ raw: String?) -> URL? {
        validatedHTTPSURL(raw)
    }

    public static func validatedHTTPSURL(_ raw: String?) -> URL? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 2_048,
              !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }),
              let components = URLComponents(string: value),
              components.scheme?.caseInsensitiveCompare("https") == .orderedSame,
              let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              let url = components.url
        else { return nil }
        return url
    }

    public static func validatedCursorURL(_ raw: String?) -> URL? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 2_048,
              !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }),
              let components = URLComponents(string: value),
              components.scheme?.caseInsensitiveCompare("cursor") == .orderedSame,
              let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              let url = components.url
        else { return nil }
        return url
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 2_000 else { return nil }
        return trimmed
    }

    private static func nonNegative(_ value: Int?) -> Int? {
        guard let value, value >= 0 else { return nil }
        return value
    }
}

public typealias WorkCardActionAvailability = WorkCardPresentation
