import SwiftUI
import UIKit
import CompanionCore

/// An agent identity image fetched from the paired computer with the device
/// bearer token. The mascot is deterministic fallback for missing, stale, or
/// undecodable attachments, so identity never becomes an empty placeholder.
struct BotAvatarView: View {
    let bot: Bot
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    @EnvironmentObject private var session: Session
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .mascot }
    private var usesImage: Bool { crop != .mascot && bot.avatarUrl != nil && !failed }
    /// A caller may request animation for a surface, but only the paired
    /// runtime can grant it. This keeps idle, waiting, and stale bots still
    /// even when a reused row or profile passes `animated: true`.
    private var activityAnimation: Bool { animated && bot.isWorking }

    var body: some View {
        Group {
            if usesImage, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(mask)
            } else {
                MausAvatar(
                    color: bot.color,
                    size: size,
                    state: state,
                    shape: bot.mascotShape?.rawValue ?? "droplet",
                    animated: activityAnimation,
                    comets: comets && activityAnimation
                )
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bot.name) avatar")
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            guard crop != .mascot, bot.avatarUrl != nil else { return }
            let data = await session.avatarData(for: bot)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = UIImage(data: data) else {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
            image = decoded
        }
    }

    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot: AnyShape(Rectangle())
        }
    }
}

struct ChatAvatarView: View {
    let chat: Chat
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
        case .room:
            MausAvatar(color: "blue", size: size, state: state, animated: animated, comets: comets)
        }
    }
}

/// Circular back / overflow control used on profile, group, and computer
/// screens. 44pt hit target, same graphite fill as the rest of the chrome.
struct ChromeCircleButton: View {
    var systemImage: String
    var weight: Font.Weight = .semibold
    var action: (() -> Void)? = nil

    var body: some View {
        let glyph = Image(systemName: systemImage)
            .font(.system(size: 17, weight: weight))
            .foregroundStyle(Color.primary)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        Group {
            if let action {
                Button(action: action) { glyph }
            } else {
                glyph
            }
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .background(VBotSurface.controlSurface, in: Circle())
        .contentShape(Circle())
    }
}

/// Shared copy for routine rows on agent and group profiles.
enum ProfileScheduleText {
    static func summary(_ routine: Routine) -> String {
        let schedule = scheduleLine(routine.schedule)
        return routine.enabled ? schedule : "\(schedule) · Paused"
    }

    static func scheduleLine(_ schedule: RoutineSchedule) -> String {
        switch schedule.type {
        case .daily:
            let days = schedule.weekdays ?? []
            let dayLabel: String
            if days.count == 7 {
                dayLabel = "Every day"
            } else if days == [1, 2, 3, 4, 5] {
                dayLabel = "Weekdays"
            } else if days.isEmpty {
                dayLabel = "Daily"
            } else {
                let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
                dayLabel = days.compactMap { index in
                    guard names.indices.contains(index) else { return nil }
                    return String(names[index].prefix(3))
                }.joined(separator: ", ")
            }
            return "\(dayLabel) at \(clock(schedule.time))"
        case .once:
            if let at = schedule.at {
                return Date(timeIntervalSince1970: at / 1_000)
                    .formatted(.dateTime.month(.abbreviated).day().hour().minute())
            }
            return "One time"
        case .unknown:
            return "Schedule from computer"
        }
    }

    static func clock(_ time: String?) -> String {
        guard let time, !time.isEmpty else { return "scheduled time" }
        let parts = time.split(separator: ":")
        guard let hour = parts.first.flatMap({ Int($0) }) else { return time }
        let minute = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        var components = DateComponents()
        components.hour = hour
        components.minute = minute
        let date = Calendar(identifier: .gregorian).date(from: components) ?? Date()
        return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened))
    }
}
