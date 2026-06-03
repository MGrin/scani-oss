import SwiftUI
import Shared

struct AddView: View {
    let container: AppContainer

    @State private var mode = "group"
    @State private var name = ""
    @State private var color = "#3B82F6"
    @State private var desc = ""
    @State private var status: String?

    // vault
    @State private var targetAmount = ""
    @State private var selectedCurrencyId = ""
    @State private var iconName = ""
    @State private var currencies: [MobileToken] = []

    // holding
    @State private var accounts: [MobileAccount] = []
    @State private var selectedAccountId = ""
    @State private var tokenQuery = ""
    @State private var tokenResults: [MobileToken] = []
    @State private var selectedToken: MobileToken?
    @State private var balance = ""

    private var isSaveDisabled: Bool {
        switch mode {
        case "group": return name.isEmpty
        case "vault": return name.isEmpty || targetAmount.isEmpty || selectedCurrencyId.isEmpty
        default: return selectedAccountId.isEmpty || selectedToken == nil || balance.isEmpty
        }
    }

    var body: some View {
        Form {
            Picker("Type", selection: $mode) {
                Text("Group").tag("group")
                Text("Vault").tag("vault")
                Text("Holding").tag("holding")
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)

            if mode == "group" {
                Section("Group") {
                    TextField("Name", text: $name)
                    ColorSwatchPicker(selected: $color)
                    TextField("Description", text: $desc)
                }
            } else if mode == "vault" {
                Section("Vault") {
                    TextField("Name", text: $name)
                    TextField("Target Amount", text: $targetAmount)
                        .keyboardType(.decimalPad)
                    Picker("Currency", selection: $selectedCurrencyId) {
                        Text("Select…").tag("")
                        ForEach(currencies, id: \.id) { t in
                            Text("\(t.symbol) — \(t.name)").tag(t.id)
                        }
                    }
                    ColorSwatchPicker(selected: $color)
                    TextField("Icon Name", text: $iconName)
                    TextField("Description", text: $desc)
                }
            } else {
                Section("Holding") {
                    Picker("Account", selection: $selectedAccountId) {
                        ForEach(accounts, id: \.id) { a in
                            Text(a.name).tag(a.id)
                        }
                    }
                    TextField("Search token…", text: $tokenQuery)
                        .autocorrectionDisabled()
                    if let t = selectedToken {
                        HStack {
                            Text("\(t.symbol) — \(t.name)").font(.subheadline)
                            Spacer()
                            Button("Clear") { selectedToken = nil; tokenQuery = "" }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } else if !tokenResults.isEmpty {
                        ForEach(tokenResults, id: \.id) { t in
                            Button {
                                selectedToken = t
                                tokenQuery = ""
                                tokenResults = []
                            } label: {
                                Text("\(t.symbol) — \(t.name)").foregroundStyle(.primary)
                            }
                        }
                    }
                    TextField("Balance", text: $balance)
                        .keyboardType(.decimalPad)
                }
            }

            Section {
                Button("Save") {
                    Task {
                        do {
                            switch mode {
                            case "group":
                                _ = try await container.writeQueue.createGroup(
                                    name: name,
                                    color: color,
                                    description: desc.isEmpty ? nil : desc
                                )
                            case "vault":
                                _ = try await container.writeQueue.createVault(
                                    name: name,
                                    targetAmount: targetAmount,
                                    currencyId: selectedCurrencyId,
                                    color: color,
                                    iconName: iconName.isEmpty ? nil : iconName,
                                    description: desc.isEmpty ? nil : desc
                                )
                            default:
                                if let token = selectedToken {
                                    _ = try await container.writeQueue.createHolding(
                                        accountId: selectedAccountId,
                                        tokenId: token.id,
                                        symbol: token.symbol,
                                        name: token.name,
                                        balance: balance
                                    )
                                }
                            }
                            try? await container.outboxProcessor.drain()
                            status = "Saved ✓"
                            resetFields()
                        } catch {
                            status = error.localizedDescription
                        }
                    }
                }
                .disabled(isSaveDisabled)
                if let status {
                    Text(status).foregroundStyle(status == "Saved ✓" ? .green : .red)
                }
            }
        }
        .navigationTitle("Add")
        .task {
            accounts = (try? await container.accountsRepository.snapshot()) ?? []
            if let first = accounts.first { selectedAccountId = first.id }
            currencies = (try? await container.mobileApi.currencies()) ?? []
        }
        .task(id: tokenQuery) {
            guard tokenQuery.count >= 2 else { tokenResults = []; return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            tokenResults = (try? await container.mobileApi.searchTokens(query: tokenQuery)) ?? []
        }
    }

    private func resetFields() {
        name = ""; desc = ""; targetAmount = ""; selectedCurrencyId = ""; iconName = ""
        tokenQuery = ""; tokenResults = []; selectedToken = nil; balance = ""
        color = "#3B82F6"
    }
}
