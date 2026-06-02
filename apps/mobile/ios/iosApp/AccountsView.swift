import SwiftUI
import Shared

@MainActor
final class AccountsViewModel: ObservableObject {
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

struct AccountsView: View {
    @StateObject private var model: AccountsViewModel

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: AccountsViewModel(
            repo: container.accountsRepository, sync: container.syncEngine))
    }

    var body: some View {
        List(model.accounts, id: \.id) { a in
            VStack(alignment: .leading) {
                Text(a.name)
                Text(a.totalValue).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Accounts")
        .refreshable { await model.refresh() }
        .task { await model.load() }
    }
}
