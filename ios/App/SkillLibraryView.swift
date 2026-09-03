import CompanionCore
import SwiftUI

struct SkillLibrarySheet: View {
    let bot: Bot

    var body: some View {
        NavigationStack {
            SkillLibraryView(bot: bot)
        }
        .presentationDragIndicator(.visible)
    }
}

struct SkillLibraryView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @AppStorage("busySendDefault") private var busySendDefault = BusySendDefault.steer.rawValue
    @State private var skills: [BotSkill] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var runningName: String?

    private var current: Bot { session.state.bot(bot.id) ?? bot }

    var body: some View {
        ScrollView {
            VStack(spacing: VBotSurface.Space.section) {
                if CalmSurfacePolicy.showsSkeleton(isLoading: loading, hasCachedRows: !skills.isEmpty) {
                    VBotSurfaceGroup {
                        CalmSkeletonList(rows: 4, label: "Loading skills")
                    }
                } else if let loadError {
                    VBotSurfaceGroup {
                        Text(loadError)
                            .foregroundStyle(.secondary)
                            .padding(16)
                        VBotHairline().padding(.leading, 16)
                        Button("Try again") { Task { await load() } }
                            .padding(.horizontal, 16)
                            .frame(minHeight: VBotSurface.Hit.row)
                    }
                } else if skills.isEmpty {
                    VBotSurfaceGroup {
                        Text("No skills yet")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 18)
                            .frame(minHeight: VBotSurface.Hit.row, alignment: .leading)
                    }
                } else {
                    VBotSurfaceGroup(title: "Skills") {
                        ForEach(Array(skills.enumerated()), id: \.element.id) { index, skill in
                            skillRow(skill)
                            if index < skills.count - 1 {
                                VBotHairline().padding(.leading, 16)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, VBotSurface.Space.page)
            .padding(.top, VBotSurface.Space.section)
            .padding(.bottom, 36)
        }
        .navigationTitle("Skills")
        .navigationBarTitleDisplayMode(.inline)
        .vbotCanvas()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task { await load() }
    }

    private func skillRow(_ skill: BotSkill) -> some View {
        let description = SkillLibraryRunPolicy.visibleDescription(skill.description)
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(skill.name)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                if let description {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 8)
            Button("Run") {
                Task { await run(skill) }
            }
            .font(.body.weight(.semibold))
            .disabled(runningName != nil)
            .accessibilityLabel("Run \(skill.name)")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: VBotSurface.Hit.row)
    }

    private func load() async {
        loading = true
        loadError = nil
        if let loaded = await session.loadBotSkills(botId: current.id) {
            skills = CalmSurfacePolicy.selectCatalog(
                cached: skills,
                incoming: loaded,
                failed: false
            )
            loadError = nil
        } else {
            loadError = session.actionError ?? "Could not load skills."
        }
        loading = false
    }

    private func run(_ skill: BotSkill) async {
        guard runningName == nil else { return }
        runningName = skill.name
        defer { runningName = nil }
        let command = CommandSkillItem.library(skill).command
        let capabilities = VBotMutationRouting.composerCapabilities(for: session.engineSync, bot: current)
        let mode = current.busy == true
            ? ComposerActionPolicy.deliveryMode(
                defaultMode: BusySendDefault(rawValue: busySendDefault),
                capabilities: capabilities
            )
            : .auto
        Haptics.selection()
        _ = await session.send(command, to: .bot(current), mode: mode)
    }
}
