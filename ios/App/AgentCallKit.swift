// Outgoing CallKit for a user-started agent call.
//
// Feasible without VoIP push: CXCallController.request(CXStartCallAction)
// reports one outgoing CXCall. There is no incoming call and no PushKit.
// `voip` is intentionally not in UIBackgroundModes — Apple requires that
// mode to pair with PushKit, which this product does not use.
//
// Audio stays app-owned (`CallAudioSession`). CallKit's didActivate is
// observed and the call category is reapplied, but the half-duplex loop
// must keep playAndRecord + voiceChat active through thinking, and yielding
// the session to CallKit would let it deactivate between listen and speak.
import AVFoundation
import CallKit
import CompanionCore
import Foundation
import UIKit

/// Owns the call-long AVAudioSession. SpeechDictation and MessageSpeaker
/// must not deactivate it while `isOwned` is true, and must not start
/// recognition and TTS together.
enum CallAudioSession {
    private(set) static var isOwned = false

    static func configureForCall() {
        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = []
        if VoiceCallAudioPolicy.defaultToSpeaker {
            options.insert(.defaultToSpeaker)
        }
        if VoiceCallAudioPolicy.allowBluetooth {
            options.insert(.allowBluetooth)
        }
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
            try session.setActive(true)
            isOwned = true
        } catch {
            isOwned = false
        }
    }

    static func reapply() {
        guard isOwned else { return }
        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = []
        if VoiceCallAudioPolicy.defaultToSpeaker {
            options.insert(.defaultToSpeaker)
        }
        if VoiceCallAudioPolicy.allowBluetooth {
            options.insert(.allowBluetooth)
        }
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try? session.setActive(true)
    }

    static func release() {
        guard isOwned else { return }
        isOwned = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

final class AgentCallKit: NSObject, CXProviderDelegate {
    static let shared = AgentCallKit()

    private let provider: CXProvider
    private let controller = CXCallController()
    private var state = AgentCallKitState.empty
    private var closeHandler: (() -> Void)?
    private var muteHandler: ((Bool) -> Void)?

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportsVideo = false
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = true
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func attach(close: @escaping () -> Void, mute: @escaping (Bool) -> Void) {
        closeHandler = close
        muteHandler = mute
    }

    func detach() {
        closeHandler = nil
        muteHandler = nil
    }

    func startOutgoing(handle: String) {
        apply(.userStarted(handle: handle))
    }

    func end() {
        apply(.userEnded)
    }

    func setMuted(_ muted: Bool) {
        apply(.userSetMuted(muted))
    }

    private func apply(_ event: AgentCallKitEvent) {
        let uuid = state.uuid ?? UUID()
        let result = AgentCallKitPolicy.reduce(state: state, event: event, newUUID: uuid)
        state = result.0
        for action in result.1 {
            perform(action)
        }
    }

    private func perform(_ action: AgentCallKitAction) {
        switch action {
        case let .requestStartOutgoing(uuid, handle):
            let start = CXStartCallAction(
                call: uuid,
                handle: CXHandle(type: .generic, value: handle)
            )
            start.isVideo = false
            controller.request(CXTransaction(action: start)) { _ in }
        case let .requestEnd(uuid):
            controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
        case let .requestMute(uuid, muted):
            controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
        case .closeVoiceSession:
            closeHandler?()
        case let .applyMuted(muted):
            muteHandler?(muted)
        }
    }

    func providerDidReset(_ provider: CXProvider) {
        apply(.providerReset)
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
        action.fulfill()
        apply(.providerStarted)
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        action.fulfill()
        apply(.systemEnded)
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let muted = action.isMuted
        action.fulfill()
        apply(.systemSetMuted(muted))
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        CallAudioSession.reapply()
    }
}
