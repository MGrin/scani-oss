import SwiftUI
import Shared

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var accounts: [MobileAccount] = []
    private let repo: AccountsRepository
    private let sync: SyncEngine

    init(repo: AccountsRepository, sync: SyncEngine) {
        self.repo = repo
        self.sync = sync
    }

    func load() async {
        accounts = (try? await repo.snapshot()) ?? []
    }

    func refresh() async {
        try? await sync.syncAccounts()
        await load()
    }
}

struct DashboardView: View {
    @StateObject private var model: DashboardViewModel

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: DashboardViewModel(
            repo: container.accountsRepository, sync: container.syncEngine))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(model.accounts.count) accounts").font(.headline).padding(.horizontal)
            List(model.accounts, id: \.id) { a in
                Text(a.name)
            }
        }
        .navigationTitle("Dashboard")
        .refreshable { await model.refresh() }
        .task { await model.load() }
    }
}
