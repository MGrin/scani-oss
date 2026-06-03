import SwiftUI
import Shared

@MainActor
final class SettingsViewModel: ObservableObject {
    @Published var pending: [Outbox] = []
    let container: AppContainer

    init(container: AppContainer) {
        self.container = container
    }

    func load() async {
        pending = (try? await container.outboxRepository.pending()) ?? []
    }

    func retry() async {
        try? await container.outboxProcessor.drain()
        await load()
    }

    func discard(_ item: Outbox) async {
        try? await container.outboxRepository.markDone(id: item.id)
        await resync(item.entity)
        await load()
    }

    private func resync(_ entity: String) async {
        switch entity {
        case "account": try? await container.syncEngine.syncAccounts()
        case "holding": try? await container.syncEngine.syncHoldings()
        case "group": try? await container.syncEngine.syncGroups()
        case "vault": try? await container.syncEngine.syncVaults()
        default: break
        }
    }
}

struct SettingsView: View {
    @StateObject private var model: SettingsViewModel

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: SettingsViewModel(container: container))
    }

    var body: some View {
        List {
            Section("Sync queue") {
                if model.pending.isEmpty {
                    Text("All changes synced ✓")
                        .foregroundStyle(.secondary)
                } else {
                    Text("\(model.pending.count) queued write(s)")
                        .foregroundStyle(.secondary)
                    ForEach(model.pending, id: \.id) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(item.op) \(item.entity)")
                            if item.attempts >= 1 {
                                Text(item.lastError ?? "Failed")
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        .swipeActions(edge: .leading) {
                            Button("Retry") {
                                Task { await model.retry() }
                            }
                            .tint(.blue)
                        }
                        .swipeActions(edge: .trailing) {
                            Button("Discard", role: .destructive) {
                                Task { await model.discard(item) }
                            }
                        }
                    }
                }
            }
            Section {
                Button("Sign out", role: .destructive) {
                    Task { try? await model.container.authRepository.signOut() }
                }
            }
        }
        .navigationTitle("Settings")
        .task { await model.load() }
    }
}
