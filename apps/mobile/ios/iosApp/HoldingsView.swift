import SwiftUI
import Shared

@MainActor
final class HoldingsViewModel: ObservableObject {
    @Published var holdings: [MobileHolding] = []
    private let repo: HoldingsRepository
    private let sync: SyncEngine

    init(repo: HoldingsRepository, sync: SyncEngine) {
        self.repo = repo
        self.sync = sync
    }

    func load() async {
        holdings = (try? await repo.snapshot()) ?? []
    }

    func refresh() async {
        try? await sync.syncHoldings()
        await load()
    }
}

struct HoldingsView: View {
    @StateObject private var model: HoldingsViewModel

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: HoldingsViewModel(
            repo: container.holdingsRepository, sync: container.syncEngine))
    }

    var body: some View {
        List(model.holdings, id: \.id) { h in
            VStack(alignment: .leading) {
                HStack {
                    Text(h.symbol).fontWeight(.medium)
                    Text(h.name).foregroundStyle(.secondary)
                }
                Text("\(h.amount)  •  \(h.value ?? "—")").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Holdings")
        .refreshable { await model.refresh() }
        .task { await model.load() }
    }
}
