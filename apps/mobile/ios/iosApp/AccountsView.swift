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
    let writeQueue: WriteQueue
    let outboxProcessor: OutboxProcessor

    init(container: AppContainer) {
        repo = container.accountsRepository
        sync = container.syncEngine
        syncState = container.syncStateRepository
        writeQueue = container.writeQueue
        outboxProcessor = container.outboxProcessor
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

private struct EditAccountSheet: View {
    let account: MobileAccount
    let model: AccountsViewModel
    @Binding var isPresented: Bool
    let onSaved: () async -> Void

    @State private var editName: String

    init(account: MobileAccount, model: AccountsViewModel, isPresented: Binding<Bool>, onSaved: @escaping () async -> Void) {
        self.account = account
        self.model = model
        _isPresented = isPresented
        self.onSaved = onSaved
        _editName = State(initialValue: account.name)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $editName)
            }
            .navigationTitle("Edit Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            try? await model.writeQueue.updateAccount(id: account.id, name: editName)
                            try? await model.outboxProcessor.drain()
                            isPresented = false
                            await onSaved()
                        }
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
        }
    }
}

struct AccountsView: View {
    @StateObject private var model: AccountsViewModel
    @State private var editingAccount: MobileAccount?
    @State private var showingEdit = false

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: AccountsViewModel(container: container))
    }

    var body: some View {
        List {
            Section {
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Text(syncStatusLabel(model.lastSyncedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                ForEach(model.accounts, id: \.id) { a in
                    NavigationLink(value: DetailRoute.account(a.id)) {
                        VStack(alignment: .leading) {
                            Text(a.name)
                            Text(a.totalValue).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            editingAccount = a
                            showingEdit = true
                        } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                try? await model.writeQueue.deleteAccount(id: a.id)
                                try? await model.outboxProcessor.drain()
                                await model.load()
                            }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Accounts")
        .refreshable { await model.refresh() }
        .task { await model.load() }
        .sheet(isPresented: $showingEdit) {
            if let a = editingAccount {
                EditAccountSheet(account: a, model: model, isPresented: $showingEdit) {
                    await model.load()
                }
            }
        }
    }
}
