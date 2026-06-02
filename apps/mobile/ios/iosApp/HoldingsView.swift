import SwiftUI
import Shared

@MainActor
final class HoldingsViewModel: ObservableObject {
    @Published var holdings: [MobileHolding] = []
    @Published var error: String?
    @Published var lastSyncedAt: Int64?
    private let repo: HoldingsRepository
    private let sync: SyncEngine
    private let syncState: SyncStateRepository

    init(repo: HoldingsRepository, sync: SyncEngine, syncState: SyncStateRepository) {
        self.repo = repo; self.sync = sync; self.syncState = syncState
    }

    func load() async {
        holdings = (try? await repo.snapshot()) ?? []
        lastSyncedAt = (try? await syncState.lastSyncedAt(key: "holdings"))?.int64Value
    }

    func refresh() async {
        do { try await sync.syncHoldings(); error = nil }
        catch { self.error = "Offline — showing cached data" }
        await load()
    }
}

struct HoldingsView: View {
    @StateObject private var model: HoldingsViewModel

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: HoldingsViewModel(
            repo: container.holdingsRepository,
            sync: container.syncEngine,
            syncState: container.syncStateRepository))
    }

    var body: some View {
        List {
            Section {
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Text(syncStatusLabel(model.lastSyncedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                ForEach(model.holdings, id: \.id) { h in
                    VStack(alignment: .leading) {
                        HStack {
                            Text(h.symbol).fontWeight(.medium)
                            Text(h.name).foregroundStyle(.secondary)
                        }
                        Text("\(h.amount)  •  \(h.value ?? "—")").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Holdings")
        .refreshable { await model.refresh() }
        .task { await model.load() }
    }
}
