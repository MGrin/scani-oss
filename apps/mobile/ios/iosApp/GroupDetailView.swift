import SwiftUI
import Shared

@MainActor
final class GroupDetailViewModel: ObservableObject {
    @Published var group: MobileGroup?
    private let container: AppContainer
    private let groupId: String

    init(container: AppContainer, groupId: String) {
        self.container = container
        self.groupId = groupId
    }

    func load() async {
        group = try? await container.groupsRepository.groupByIdSnapshot(id: groupId)
    }
}

struct GroupDetailView: View {
    @StateObject private var model: GroupDetailViewModel

    init(container: AppContainer, groupId: String) {
        _model = StateObject(wrappedValue: GroupDetailViewModel(container: container, groupId: groupId))
    }

    var body: some View {
        Group {
            if let g = model.group {
                List {
                    Section {
                        LabeledContent("Name", value: g.name)
                        HStack {
                            Text("Color")
                            Spacer()
                            Circle()
                                .fill(Color(hex: g.color) ?? .gray)
                                .frame(width: 20, height: 20)
                        }
                        if let desc = g.description_ {
                            LabeledContent("Description", value: desc)
                        }
                    }
                }
                .navigationTitle(g.name)
            } else {
                Text("Not found").foregroundStyle(.secondary)
                    .navigationTitle("Group")
            }
        }
        .task { await model.load() }
    }
}
