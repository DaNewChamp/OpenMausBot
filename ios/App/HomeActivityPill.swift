import SwiftUI
import CompanionCore

/// The home activity rail. The home stack places it below the roster so
/// expansion reserves the full panel height instead of covering a row. Queue
/// receipts are optional because the hub does not expose a global queue
/// snapshot; the caller may pass only receipts it genuinely observed on this
/// phone.
struct HomeActivityPill: View {
    let open: (Chat) -> Void
    @Binding var expanded: Bool
    var queuedReceipts: [HomeActivityQueueReceipt] = []

    @EnvironmentObject private var session: Session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var presentation: HomeActivityPresentation {
        session.state.homeActivityPresentation(queuedReceipts: queuedReceipts)
    }

    var body: some View {
        Group {
            // Quiet is the absence of work, not another status to keep on
            // screen. Removing the rail entirely also gives the roster back
            // the bottom safe-area space instead of leaving a dead capsule.
            if HomeActivityRailLayoutPolicy.showsRail(for: presentation.state) {
                VStack(spacing: 8) {
                    if expanded {
                        expandedPanel
                            .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                    }
                    collapsedButton
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
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
            autoExpandPreviewIfNeeded()
        }
        .onChange(of: presentation.items) { _, _ in
            // StorePreview may hydrate after the first appearance. Retry on
            // the published projection instead of racing the initial render.
            autoExpandPreviewIfNeeded()
        }
#endif
        .onChange(of: presentation.state) { _, state in
            if state == .quiet, expanded { expanded = false }
        }
    }

#if DEBUG
    private func autoExpandPreviewIfNeeded() {
        guard HomeActivityPreviewExpansionPolicy.shouldAutoExpand(
            arguments: ProcessInfo.processInfo.arguments,
            presentation: presentation,
            isExpanded: expanded
        ) else { return }
        expanded = true
    }
#endif

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
                    Text(collapsedTitle)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(HomeActivityRailLayoutPolicy.collapsedTitleLineLimit(
                            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
                        ))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(collapsedSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(HomeActivityRailLayoutPolicy.collapsedSubtitleLineLimit(
                            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
                        ))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .fixedSize(horizontal: false, vertical: true)

                Image(systemName: expanded ? "chevron.down" : "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: VBotSurface.Hit.minimum, height: VBotSurface.Hit.minimum)
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .padding(.vertical, HomeActivityRailLayoutPolicy.collapsedVerticalPadding(
                isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
            ))
            .frame(
                minHeight: HomeActivityRailLayoutPolicy.collapsedMinimumHeight(
                    isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
                )
            )
            .fixedSize(horizontal: false, vertical: true)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize(
            horizontal: HomeActivityRailLayoutPolicy.collapsedUsesContentHugging(isExpanded: expanded),
            vertical: true
        )
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
        ScrollView(.vertical, showsIndicators: dynamicTypeSize.isAccessibilitySize) {
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
        .frame(height: HomeActivityPreviewExpansionPolicy.expandedPanelHeight(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
            itemCount: presentation.items.count,
            sectionCount: presentation.sections.filter { !$0.items.isEmpty }.count,
            hasNeedsYou: !presentation.needsYou.isEmpty
        ))
        .frame(maxWidth: HomeActivityRailLayoutPolicy.expandedPanelMaxWidth)
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

    private var collapsedTitle: String {
        guard HomeActivityRailLayoutPolicy.usesCompactCopy(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
        ) else { return presentation.collapsedTitle }
        switch presentation.state {
        case .quiet:
            return "Quiet"
        case .needsAttention:
            return "\(presentation.needsYou.count) waiting"
        case .active:
            return "\(presentation.totalActivityCount) active"
        }
    }

    private var collapsedSubtitle: String {
        guard HomeActivityRailLayoutPolicy.usesCompactCopy(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
        ) else { return presentation.collapsedSubtitle }
        switch presentation.state {
        case .quiet:
            return "No pending"
        case .needsAttention:
            return "Review now"
        case .active:
            return "Working now"
        }
    }
}

private struct HomeActivityRow: View {
    let item: HomeActivityPresentation.Item
    let chat: Chat
    let open: () -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
                        // Accessibility captures need the complete approval
                        // detail; the expanded panel scrolls when this grows
                        // beyond its reserved height.
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
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
