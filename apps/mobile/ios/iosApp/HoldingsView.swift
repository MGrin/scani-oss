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
    let writeQueue: WriteQueue
    let outboxProcessor: OutboxProcessor

    init(container: AppContainer) {
        repo = container.holdingsRepository
        sync = container.syncEngine
        syncState = container.syncStateRepository
        writeQueue = container.writeQueue
        outboxProcessor = container.outboxProcessor
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

private struct EditHoldingSheet: View {
    let holding: MobileHolding
    let model: HoldingsViewModel
    @Binding var isPresented: Bool
    let onSaved: () async -> Void

    @State private var editBalance: String

    init(holding: MobileHolding, model: HoldingsViewModel, isPresented: Binding<Bool>, onSaved: @escaping () async -> Void) {
        self.holding = holding
        self.model = model
        _isPresented = isPresented
        self.onSaved = onSaved
        _editBalance = State(initialValue: holding.amount)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Balance", text: $editBalance)
                    .keyboardType(.decimalPad)
            }
            .navigationTitle("Edit Holding")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            try? await model.writeQueue.updateHolding(
                                id: holding.id,
                                balance: editBalance.isEmpty ? nil : editBalance
                            )
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

struct HoldingsView: View {
    @StateObject private var model: HoldingsViewModel
    @State private var editingHolding: MobileHolding?
    @State private var showingEdit = false

    init(container: AppContainer) {
        _model = StateObject(wrappedValue: HoldingsViewModel(container: container))
    }

    var body: some View {
        List {
            Section {
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Text(syncStatusLabel(model.lastSyncedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                ForEach(model.holdings, id: \.id) { h in
                    NavigationLink(value: DetailRoute.holding(h.id)) {
                        VStack(alignment: .leading) {
                            HStack {
                                Text(h.symbol).fontWeight(.medium)
                                Text(h.name).foregroundStyle(.secondary)
                            }
                            Text("\(h.amount)  •  \(h.value ?? "—")").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            editingHolding = h
                            showingEdit = true
                        } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                try? await model.writeQueue.deleteHolding(id: h.id)
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
        .navigationTitle("Holdings")
        .refreshable { await model.refresh() }
        .task { await model.load() }
        .sheet(isPresented: $showingEdit) {
            if let h = editingHolding {
                EditHoldingSheet(holding: h, model: model, isPresented: $showingEdit) {
                    await model.load()
                }
            }
        }
    }
}
