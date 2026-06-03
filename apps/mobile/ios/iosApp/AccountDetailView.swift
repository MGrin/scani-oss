import SwiftUI
import Shared

@MainActor
final class AccountDetailViewModel: ObservableObject {
    @Published var account: MobileAccount?
    @Published var holdings: [MobileHolding] = []
    private let container: AppContainer
    private let accountId: String

    init(container: AppContainer, accountId: String) {
        self.container = container
        self.accountId = accountId
    }

    func load() async {
        account = try? await container.accountsRepository.accountByIdSnapshot(id: accountId)
        holdings = (try? await container.holdingsRepository.holdingsByAccountSnapshot(accountId: accountId)) ?? []
    }
}

struct AccountDetailView: View {
    @StateObject private var model: AccountDetailViewModel

    init(container: AppContainer, accountId: String) {
        _model = StateObject(wrappedValue: AccountDetailViewModel(container: container, accountId: accountId))
    }

    var body: some View {
        Group {
            if let a = model.account {
                List {
                    Section {
                        LabeledContent("Name", value: a.name)
                        LabeledContent("Total Value", value: a.totalValue)
                    }
                    Section("Holdings") {
                        if model.holdings.isEmpty {
                            Text("No holdings").foregroundStyle(.secondary)
                        } else {
                            ForEach(model.holdings, id: \.id) { h in
                                VStack(alignment: .leading) {
                                    Text("\(h.symbol) — \(h.name)")
                                    Text("\(h.amount)  •  \(h.value ?? "—")")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .navigationTitle(a.name)
            } else {
                Text("Not found").foregroundStyle(.secondary)
                    .navigationTitle("Account")
            }
        }
        .task { await model.load() }
    }
}
