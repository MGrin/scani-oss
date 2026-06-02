import SwiftUI
import Shared

@MainActor
final class AccountsViewModel: ObservableObject {
    @Published var accounts: [MobileAccount] = []
    @Published var error: String?
    @Published var lastSyncedAt: Int64?
    private let repo: AccountsRepository
    private let sync: SyncEngine
    private let syncState: SyncStateRepository

    init(repo: AccountsRepository, sync: SyncEngine, syncState: SyncStateRepository) {
        self.repo = repo; self.sync = sync; self.syncState = syncState
    }

    func load() async {
        accounts = (try? await repo.snapshot()) ?? []
        lastSyncedAt = (try? await syncState.lastSyncedAt(key: "accounts"))?.int64Value
    }

    func refresh() async {
        do { try await sync.syncAccounts(); error = nil }
        catch { self.error = "Offline — showing cached data" }
        await load()
    }
}

struct AccountsView: View {
    @StateObject private var model: AccountsViewModel

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: AccountsViewModel(
            repo: container.accountsRepository,
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
                ForEach(model.accounts, id: \.id) { a in
                    VStack(alignment: .leading) {
                        Text(a.name)
                        Text(a.totalValue).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Accounts")
        .refreshable { await model.refresh() }
        .task { await model.load() }
    }
}
