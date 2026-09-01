import SwiftUI
import CompanionCore

/// The home activity rail. The home stack places it below the roster so
/// expansion reserves the full panel height instead of covering a row. Queue
/// receipts are optional because the hub does not expose a global queue
/// snapshot; the caller may pass only receipts it genuinely observed on this
/// phone.
struct HomeActivityPill: View {
    let open: (Chat) -> Void
    var queuedReceipts: [HomeActivityQueueReceipt] = []

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    private var presentation: HomeActivityPresentation {
        session.state.homeActivityPresentation(queuedReceipts: queuedReceipts)
    }

    var body: some View {
        VStack(spacing: 8) {
            if expanded {
                expandedPanel
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
            }
            collapsedButton
        }
        .frame(maxWidth: 430)
        .padding(.horizontal, 14)
        .padding(.top, expanded ? 8 : 0)
        .padding(.bottom, 8)
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.82), value: expanded)
        .transaction { transaction in
            if reduceMotion {
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
#if DEBUG
        .onAppear {
            // Keep expanded-state captures deterministic without adding any
            // production state or changing the normal collapsed launch.
            if ProcessInfo.processInfo.arguments.contains("-preview-expand-activity"),
               !presentation.items.isEmpty {
                expanded = true
            }
        }
#endif
        .onChange(of: presentation.state) { _, state in
            if state == .quiet, expanded { expanded = false }
        }
    }

    private var collapsedButton: some View {
        Button {
            guard !presentation.items.isEmpty else { return }
            Haptics.selection()
            expanded.toggle()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 22, height: 22)
                    .foregroundStyle(tint)

                VStack(alignment: .leading, spacing: 1) {
                    Text(presentation.collapsedTitle)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(presentation.collapsedSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)
                Image(systemName: expanded ? "chevron.down" : "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: VBotSurface.Hit.minimum, height: VBotSurface.Hit.minimum)
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .frame(minHeight: VBotSurface.Hit.minimum)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilityLabel)
        .accessibilityValue("\(presentation.totalActivityCount) items")
        .accessibilityHint(
            presentation.items.isEmpty
                ? "No activity"
                : (expanded ? "Collapses activity" : "Expands activity")
        )
    }

    private var expandedPanel: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(presentation.sections) { section in
                    let rows = section.items.compactMap { item -> (HomeActivityPresentation.Item, Chat)? in
                        guard let chat = session.state.chat(forThread: item.threadId) else { return nil }
                        return (item, chat)
                    }
                    if !rows.isEmpty {
                        Text(section.title.uppercased())
                            .font(.caption2.weight(.bold))
                            .tracking(0.6)
                            .foregroundStyle(section.kind == .needsYou ? Color.accentColor : Color.secondary)
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                            .padding(.bottom, 3)

                        ForEach(rows, id: \.0.id) { item, chat in
                            HomeActivityRow(item: item, chat: chat) {
                                Haptics.selection()
                                expanded = false
                                open(chat)
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 8)
        }
        .frame(maxHeight: 320)
        .glassSheet(cornerRadius: VBotSurface.Radius.sheet)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Activity details")
    }

    private var icon: String {
        switch presentation.state {
        case .quiet: return "checkmark.circle.fill"
        case .active: return "bolt.fill"
        case .needsAttention: return "hand.raised.fill"
        }
    }

    private var tint: Color {
        switch presentation.state {
        case .quiet: return .secondary
        case .active: return .accentColor
        case .needsAttention: return .orange
        }
    }
}

private struct HomeActivityRow: View {
    let item: HomeActivityPresentation.Item
    let chat: Chat
    let open: () -> Void
    @EnvironmentObject private var session: Session

    var body: some View {
        Button(action: open) {
            HStack(alignment: .center, spacing: 10) {
                ChatAvatarView(chat: chat, size: 32, state: MausState.forChat(chat, in: session.state))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(item.subtitle.isEmpty ? fallbackSubtitle : item.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                trailing
            }
            .padding(.horizontal, 16)
            .frame(minHeight: VBotSurface.Hit.minimum)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title), \(item.group.title)")
        .accessibilityValue(item.subtitle.isEmpty ? fallbackSubtitle : item.subtitle)
    }

    @ViewBuilder
    private var trailing: some View {
        switch item.group {
        case .needsYou:
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(.orange)
        case .active:
            ProgressView().controlSize(.small)
        case .queued:
            Label("\(max(item.queueCount, 1))", systemImage: "clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
        case .recentlyFinished:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        }
    }

    private var fallbackSubtitle: String {
        switch item.group {
        case .needsYou: return "Waiting on you"
        case .active: return "Working now"
        case .queued: return "Queued"
        case .recentlyFinished: return "Finished"
        }
    }
}
