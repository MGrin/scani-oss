import SwiftUI
import Shared

@MainActor
final class HoldingDetailViewModel: ObservableObject {
    @Published var holding: MobileHolding?
    private let container: AppContainer
    private let holdingId: String

    init(container: AppContainer, holdingId: String) {
        self.container = container
        self.holdingId = holdingId
    }

    func load() async {
        holding = try? await container.holdingsRepository.holdingByIdSnapshot(id: holdingId)
    }
}

struct HoldingDetailView: View {
    @StateObject private var model: HoldingDetailViewModel

    init(container: AppContainer, holdingId: String) {
        _model = StateObject(wrappedValue: HoldingDetailViewModel(container: container, holdingId: holdingId))
    }

    var body: some View {
        Group {
            if let h = model.holding {
                List {
                    Section {
                        LabeledContent("Symbol", value: h.symbol)
                        LabeledContent("Name", value: h.name)
                        LabeledContent("Amount", value: h.amount)
                        LabeledContent("Value", value: h.value ?? "—")
                        LabeledContent("Account ID", value: h.accountId)
                    }
                }
                .navigationTitle(h.symbol)
            } else {
                Text("Not found").foregroundStyle(.secondary)
                    .navigationTitle("Holding")
            }
        }
        .task { await model.load() }
    }
}
