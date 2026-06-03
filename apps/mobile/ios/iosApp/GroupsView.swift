import SwiftUI
import Shared

@MainActor
final class GroupsViewModel: ObservableObject {
    @Published var groups: [MobileGroup] = []
    @Published var error: String?
    @Published var lastSyncedAt: Int64?
    private let container: AppContainer

    init(container: AppContainer) {
        self.container = container
    }

    func load() async {
        groups = (try? await container.groupsRepository.snapshot()) ?? []
        lastSyncedAt = (try? await container.syncStateRepository.lastSyncedAt(key: "groups"))?.int64Value
    }

    func refresh() async {
        do { try await container.syncEngine.syncGroups(); error = nil }
        catch { self.error = "Offline — showing cached data" }
        await load()
    }
}

private struct EditGroupSheet: View {
    let group: MobileGroup
    let container: AppContainer
    @Binding var isPresented: Bool
    let onSaved: () async -> Void

    @State private var editName: String
    @State private var editColor: String
    @State private var editDesc: String

    init(group: MobileGroup, container: AppContainer, isPresented: Binding<Bool>, onSaved: @escaping () async -> Void) {
        self.group = group
        self.container = container
        _isPresented = isPresented
        self.onSaved = onSaved
        _editName = State(initialValue: group.name)
        _editColor = State(initialValue: group.color)
        _editDesc = State(initialValue: group.description_ ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $editName)
                TextField("Color", text: $editColor)
                TextField("Description", text: $editDesc)
            }
            .navigationTitle("Edit Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            try? await container.writeQueue.updateGroup(
                                id: group.id,
                                name: editName,
                                color: editColor.isEmpty ? nil : editColor,
                                description: editDesc.isEmpty ? nil : editDesc
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

struct GroupsView: View {
    @StateObject private var model: GroupsViewModel
    private let container: AppContainer
    @State private var editingGroup: MobileGroup?
    @State private var showingEdit = false

    init(container: AppContainer) {
        self.container = container
        _model = StateObject(wrappedValue: GroupsViewModel(container: container))
    }

    var body: some View {
        List {
            Section {
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Text(syncStatusLabel(model.lastSyncedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                ForEach(model.groups, id: \.id) { g in
                    Button {
                        editingGroup = g
                        showingEdit = true
                    } label: {
                        VStack(alignment: .leading) {
                            Text(g.name)
                            Text(g.color).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .foregroundStyle(.primary)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                try? await container.writeQueue.deleteGroup(id: g.id)
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
        .navigationTitle("Groups")
        .refreshable { await model.refresh() }
        .task { await model.load() }
        .sheet(isPresented: $showingEdit) {
            if let g = editingGroup {
                EditGroupSheet(group: g, container: container, isPresented: $showingEdit) {
                    await model.load()
                }
            }
        }
    }
}
