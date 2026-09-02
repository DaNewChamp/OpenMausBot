import SwiftUI
import CompanionCore

/// Compact chooser for a two-bot channel: pick which participant's perspective
/// opens the shared canonical transcript.
struct BotChannelChooserSheet: View {
    let room: Room
    let invokingBotId: String?
    let onSelect: (String) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    private var orderedMemberIds: [String] {
        BotChannelPolicy.participantOrder(memberIds: room.memberIds, invokingBotId: invokingBotId)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(orderedMemberIds, id: \.self) { botId in
                        if let bot = session.state.bot(botId) {
                            Button {
                                Haptics.selection()
                                onSelect(botId)
                                dismiss()
                            } label: {
                                HStack(spacing: 12) {
                                    BotAvatarView(bot: bot, size: 36, state: .idle, animated: false)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(bot.name)
                                            .font(.body.weight(.medium))
                                            .foregroundStyle(.primary)
                                        Text("Open shared conversation")
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(bot.name), open shared conversation")
                            .accessibilityHint("Both bots share one transcript. Choose whose perspective to open from.")
                        }
                    }
                } footer: {
                    Text("Both bots share one transcript. Choose whose perspective to open from.")
                }
            }
            .navigationTitle("Bot conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .scrollContentBackground(.hidden)
            .background(VBotSurface.background.ignoresSafeArea())
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}

struct BotChannelOpenIntent: Identifiable {
    let id = UUID()
    let room: Room
    let focusMessageId: String?
    let invokingBotId: String?
}
