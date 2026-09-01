import Foundation

/// Describes how profile dismissal and background saves interact. The UI must
/// dismiss immediately and never await network on the navigation path.
public enum ProfileLeaveSavePolicy: Sendable {
    public struct Plan: Equatable, Sendable {
        public var saveProfileAfterDismiss: Bool
        public var cancelInFlightModelSave: Bool

        public init(saveProfileAfterDismiss: Bool, cancelInFlightModelSave: Bool) {
            self.saveProfileAfterDismiss = saveProfileAfterDismiss
            self.cancelInFlightModelSave = cancelInFlightModelSave
        }
    }

    public static let blocksDismissOnSave = false

    public static func leavePlan(profileDirty: Bool, modelDirty: Bool) -> Plan {
        Plan(
            saveProfileAfterDismiss: profileDirty,
            cancelInFlightModelSave: false
        )
    }

    public static func swipeDismissPlan(profileDirty: Bool) -> Plan {
        leavePlan(profileDirty: profileDirty, modelDirty: false)
    }
}
