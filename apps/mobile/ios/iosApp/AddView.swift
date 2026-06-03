import SwiftUI
import Shared

struct AddView: View {
    let container: AppContainer

    @State private var mode = "group"
    @State private var name = ""
    @State private var color = "#3B82F6"
    @State private var desc = ""
    @State private var targetAmount = ""
    @State private var currencyId = ""
    @State private var iconName = ""
    @State private var accounts: [MobileAccount] = []
    @State private var selectedAccountId = ""
    @State private var tokenId = ""
    @State private var symbol = ""
    @State private var balance = ""
    @State private var status: String?

    private var isSaveDisabled: Bool {
        switch mode {
        case "group": return name.isEmpty
        case "vault": return name.isEmpty || targetAmount.isEmpty || currencyId.isEmpty
        default: return selectedAccountId.isEmpty || tokenId.isEmpty || symbol.isEmpty || name.isEmpty || balance.isEmpty
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
                    TextField("Color", text: $color)
                    TextField("Description", text: $desc)
                }
            } else if mode == "vault" {
                Section("Vault") {
                    TextField("Name", text: $name)
                    TextField("Target Amount", text: $targetAmount)
                        .keyboardType(.decimalPad)
                    TextField("Currency ID", text: $currencyId)
                    TextField("Color", text: $color)
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
                    TextField("Token ID", text: $tokenId)
                    TextField("Symbol", text: $symbol)
                    TextField("Name", text: $name)
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
                                    currencyId: currencyId,
                                    color: color,
                                    iconName: iconName.isEmpty ? nil : iconName,
                                    description: desc.isEmpty ? nil : desc
                                )
                            default:
                                _ = try await container.writeQueue.createHolding(
                                    accountId: selectedAccountId,
                                    tokenId: tokenId,
                                    symbol: symbol,
                                    name: name,
                                    balance: balance
                                )
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
        }
    }

    private func resetFields() {
        name = ""; desc = ""; targetAmount = ""; currencyId = ""; iconName = ""
        tokenId = ""; symbol = ""; balance = ""
        color = "#3B82F6"
    }
}
