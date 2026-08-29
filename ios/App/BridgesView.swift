import SwiftUI
import CompanionCore

struct BridgesView: View {
    @EnvironmentObject private var session: Session
    @State private var bridges: [BridgeHost] = []
    @State private var loading = true
    @State private var error: String?
    @State private var pendingRevoke: BridgeHost?

    var body: some View {
        Group {
            if loading {
                ProgressView("Loading bridges…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                ContentUnavailableView("Couldn’t load bridges", systemImage: "laptopcomputer.trianglebadge.exclamationmark", description: Text(error))
            } else if bridges.isEmpty {
                ContentUnavailableView(
                    "No paired bridges",
                    systemImage: "laptopcomputer",
                    description: Text("Pair a Mac mini or other home machine from the harness host. Fresh bridges advertise no capabilities until you opt in.")
                )
            } else {
                List(bridges) { bridge in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(bridge.name)
                                .font(.body.weight(.medium))
                            Spacer()
                            Text(bridge.online == true ? "Online" : "Offline")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(bridge.online == true ? Color.green : Color.secondary)
                        }
                        Text(capabilitySummary(bridge))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            pendingRevoke = bridge
                        } label: {
                            Label("Revoke", systemImage: "trash")
                        }
                        Button {
                            Task { await rotate(bridge) }
                        } label: {
                            Label("Rotate token", systemImage: "key.horizontal")
                        }
                        .tint(.orange)
                    }
                }
            }
        }
        .navigationTitle("Bridges")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog(
            "Revoke \(pendingRevoke?.name ?? "this bridge")?",
            isPresented: Binding(
                get: { pendingRevoke != nil },
                set: { if !$0 { pendingRevoke = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let bridge = pendingRevoke {
                    Task { await revoke(bridge) }
                }
            }
            Button("Cancel", role: .cancel) { pendingRevoke = nil }
        } message: {
            Text("The daemon must re-pair. In-flight jobs are cancel-requested.")
        }
    }

    private func capabilitySummary(_ bridge: BridgeHost) -> String {
        let caps = bridge.capabilities
        if caps.isEmpty { return "No capabilities (opt-in on the daemon)" }
        return caps.joined(separator: " · ")
    }

    private func load() async {
        loading = bridges.isEmpty
        error = nil
        bridges = await session.listBridges()
        loading = false
    }

    private func revoke(_ bridge: BridgeHost) async {
        if await session.revokeBridge(bridge) {
            pendingRevoke = nil
            await load()
        }
    }

    private func rotate(_ bridge: BridgeHost) async {
        if await session.rotateBridgeToken(bridge) {
            await load()
        }
    }
}
