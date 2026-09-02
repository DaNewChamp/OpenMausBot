import Foundation

/// Navigation contract for temporary-agent rows opened from home vs inside chat.
public enum ChatActivityNavigationPolicy: Sendable {
    public enum Action: String, Sendable {
        case openFromHome
        case pushFocusedTranscript
    }

    /// Home opens through roster navigation; an in-chat row must push the
    /// focused transcript while keeping the parent chat on the stack.
    public static func action(fromParentThreadId: String?) -> Action {
        fromParentThreadId == nil ? .openFromHome : .pushFocusedTranscript
    }
}
