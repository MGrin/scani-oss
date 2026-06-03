import SwiftUI
import Shared

@MainActor
final class VaultDetailViewModel: ObservableObject {
    @Published var vault: MobileVault?
    private let container: AppContainer
    private let vaultId: String

    init(container: AppContainer, vaultId: String) {
        self.container = container
        self.vaultId = vaultId
    }

    func load() async {
        vault = try? await container.vaultsRepository.vaultByIdSnapshot(id: vaultId)
    }
}

struct VaultDetailView: View {
    @StateObject private var model: VaultDetailViewModel

    init(container: AppContainer, vaultId: String) {
        _model = StateObject(wrappedValue: VaultDetailViewModel(container: container, vaultId: vaultId))
    }

    var body: some View {
        Group {
            if let v = model.vault {
                let target = Double(v.targetAmount) ?? 1
                let current = Double(v.currentAmount) ?? 0
                let ratio = target > 0 ? min(max(current / target, 0), 1) : 0

                List {
                    Section {
                        LabeledContent("Name", value: v.name)
                        HStack {
                            Text("Color")
                            Spacer()
                            Circle()
                                .fill(Color(hex: v.color) ?? .gray)
                                .frame(width: 20, height: 20)
                        }
                        LabeledContent("Progress", value: "\(v.currentAmount) / \(v.targetAmount)")
                        ProgressView(value: ratio)
                            .tint(Color(hex: v.color) ?? .accentColor)
                        if let desc = v.description_ {
                            LabeledContent("Description", value: desc)
                        }
                    }
                }
                .navigationTitle(v.name)
            } else {
                Text("Not found").foregroundStyle(.secondary)
                    .navigationTitle("Vault")
            }
        }
        .task { await model.load() }
    }
}
