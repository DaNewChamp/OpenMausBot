// What the Updates pill opens: the active bots, grouped by what they need.
//
// Needs you first, with the answer right there — the phone exists so that
// a stopped bot on the laptop can be un-stopped from wherever you are.
// Then what is working, then what finished while you were not looking.
import SwiftUI
import CompanionCore

struct UpdatesSheet: View {
    let open: (Chat) -> Void
    @EnvironmentObject private var session: Session
    /// Queue receipts are deliberately supplied by the caller. The paired
    /// hub has no global queue snapshot, so this sheet must not infer queued
    /// work from a busy flag or from provider names.
    var queuedReceipts: [HomeActivityQueueReceipt] = []

    private var presentation: HomeActivityPresentation {
        session.state.homeActivityPresentation(queuedReceipts: queuedReceipts)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Updates")
                        .font(.system(size: 22, weight: .bold))
                    Spacer()
                    Text(presentation.collapsedTitle)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 6)

                if presentation.items.isEmpty {
                    ContentUnavailableView(
                        "Nothing needs you",
                        systemImage: "checkmark.circle",
                        description: Text("When a bot stops for an answer, is mid-task, or finishes something, it shows up here.")
                    )
                    .padding(.top, 24)
                } else {
                    ForEach(presentation.sections) { section in
                        sectionView(section)
                    }
                }
            }
            .padding(.bottom, 24)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
        .presentationCornerRadius(28)
    }

    @ViewBuilder
    private func sectionView(_ section: HomeActivityPresentation.Section) -> some View {
        let rows = section.items.compactMap { item -> (HomeActivityPresentation.Item, Chat)? in
            guard let chat = session.state.chat(forThread: item.threadId) else { return nil }
            return (item, chat)
        }
        if !rows.isEmpty {
            Text(section.title.uppercased())
                .font(.system(size: 12, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(section.kind == .needsYou ? Color.accentColor : Color.secondary)
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 2)

                ForEach(rows, id: \.0.id) { item, chat in
                    HomeActivityUpdateRow(item: item, chat: chat) { open(chat) }
                }
        }
    }
}

private struct HomeActivityUpdateRow: View {
    let item: HomeActivityPresentation.Item
    let chat: Chat
    let open: () -> Void
    @EnvironmentObject private var session: Session

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                ChatAvatarView(chat: chat, size: 40, state: MausState.forChat(chat, in: session.state))

                VStack(alignment: .leading, spacing: 3) {
                    Text(chat.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    Text(item.subtitle.isEmpty ? fallback : item.subtitle)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(item.group == .needsYou ? 3 : 1)
                        .multilineTextAlignment(.leading)

                    if let card = item.card, card.isPending, card.isPermission {
                        Text(card.actionSummary.map(OptionCard.sanitizedPresentation) ?? OptionCard.sanitizedPresentation(card.title.replacingOccurrences(of: "?", with: "")))
                            .font(.system(size: 13))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(2)
                            .padding(.top, 2)
                    }
                }

                Spacer(minLength: 0)
                trailing
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(chat.name), \(item.group.title)")
        .accessibilityValue(item.subtitle.isEmpty ? fallback : item.subtitle)
    }

    @ViewBuilder
    private var trailing: some View {
        switch item.group {
        case .needsYou:
            EmptyView()
        case .active:
            ProgressView().controlSize(.small).padding(.top, 10)
        case .queued:
            Label("\(max(item.queueCount, 1))", systemImage: "clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.secondary)
                .padding(.top, 10)
        case .recentlyFinished:
            HStack(spacing: 6) {
                Circle().fill(VBotSurface.unread).frame(width: 10, height: 10)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.secondary.opacity(0.5))
            }
            .padding(.top, 12)
        }
    }

    private var fallback: String {
        switch item.group {
        case .needsYou: return "Waiting on you"
        case .active: return "Working now"
        case .queued: return "Queued"
        case .recentlyFinished: return "Finished"
        }
    }
}
