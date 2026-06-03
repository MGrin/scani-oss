import SwiftUI
import Shared

@MainActor
final class VaultsViewModel: ObservableObject {
    @Published var vaults: [MobileVault] = []
    @Published var error: String?
    @Published var lastSyncedAt: Int64?
    private let container: AppContainer

    init(container: AppContainer) {
        self.container = container
    }

    func load() async {
        vaults = (try? await container.vaultsRepository.snapshot()) ?? []
        lastSyncedAt = (try? await container.syncStateRepository.lastSyncedAt(key: "vaults"))?.int64Value
    }

    func refresh() async {
        do { try await container.syncEngine.syncVaults(); error = nil }
        catch { self.error = "Offline — showing cached data" }
        await load()
    }
}

private struct EditVaultSheet: View {
    let vault: MobileVault
    let container: AppContainer
    @Binding var isPresented: Bool
    let onSaved: () async -> Void

    @State private var editName: String
    @State private var editTargetAmount: String
    @State private var editColor: String

    init(vault: MobileVault, container: AppContainer, isPresented: Binding<Bool>, onSaved: @escaping () async -> Void) {
        self.vault = vault
        self.container = container
        _isPresented = isPresented
        self.onSaved = onSaved
        _editName = State(initialValue: vault.name)
        _editTargetAmount = State(initialValue: vault.targetAmount)
        _editColor = State(initialValue: vault.color)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $editName)
                TextField("Target Amount", text: $editTargetAmount)
                    .keyboardType(.decimalPad)
                ColorSwatchPicker(selected: $editColor)
            }
            .navigationTitle("Edit Vault")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            try? await container.writeQueue.updateVault(
                                id: vault.id,
                                name: editName,
                                targetAmount: editTargetAmount.isEmpty ? nil : editTargetAmount,
                                currencyId: nil,
                                color: editColor,
                                iconName: nil,
                                description: nil
                            )
                            try? await container.outboxProcessor.drain()
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

struct VaultsView: View {
    @StateObject private var model: VaultsViewModel
    private let container: AppContainer
    @State private var editingVault: MobileVault?
    @State private var showingEdit = false

    init(container: AppContainer) {
        self.container = container
        _model = StateObject(wrappedValue: VaultsViewModel(container: container))
    }

    var body: some View {
        List {
            Section {
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Text(syncStatusLabel(model.lastSyncedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                ForEach(model.vaults, id: \.id) { v in
                    NavigationLink(value: DetailRoute.vault(v.id)) {
                        HStack {
                            Circle()
                                .fill(Color(hex: v.color) ?? .gray)
                                .frame(width: 12, height: 12)
                            VStack(alignment: .leading) {
                                Text(v.name)
                                Text("\(v.currentAmount) / \(v.targetAmount)").font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            editingVault = v
                            showingEdit = true
                        } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                try? await container.writeQueue.deleteVault(id: v.id)
                                try? await container.outboxProcessor.drain()
                                await model.load()
                            }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Vaults")
        .refreshable { await model.refresh() }
        .task { await model.load() }
        .sheet(isPresented: $showingEdit) {
            if let v = editingVault {
                EditVaultSheet(vault: v, container: container, isPresented: $showingEdit) {
                    await model.load()
                }
            }
        }
    }
}
