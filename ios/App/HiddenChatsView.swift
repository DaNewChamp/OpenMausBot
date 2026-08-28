import SwiftUI
import CompanionCore

/// Bots hidden from the roster. Unhide here or open a 1:1 without restoring
/// them to the main list.
struct HiddenChatsView: View {
    @EnvironmentObject private var session: Session

    private var hiddenBots: [Bot] {
        session.state.bots.filter { $0.hidden == true }
    }

    var body: some View {
        Group {
            if hiddenBots.isEmpty {
                ContentUnavailableView(
                    "No hidden chats",
                    systemImage: "eye.slash",
                    description: Text("Hide a bot from the chat list to manage it here.")
                )
            } else {
                List(hiddenBots) { bot in
                    NavigationLink {
                        ChatView(chat: .bot(bot))
                    } label: {
                        HStack(spacing: 12) {
                            BotAvatarView(bot: bot, size: 40, state: .idle, animated: false)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(bot.name)
                                    .font(.body.weight(.medium))
                                Text(bot.title)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .swipeActions(edge: .trailing) {
                        Button {
                            Task { _ = await session.setBotHidden(bot, hidden: false) }
                        } label: {
                            Label("Unhide", systemImage: "eye")
                        }
                        .tint(.accentColor)
                    }
                }
            }
        }
        .navigationTitle("Hidden chats")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(VBotSurface.background.ignoresSafeArea())
    }
}
