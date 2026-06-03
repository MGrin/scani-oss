import Combine
import SwiftUI
import Shared

struct MainShell: View {
    let container: AppContainer
    @EnvironmentObject private var router: DeepLinkRouter
    @State private var selection = "dashboard"
    @State private var holdingsPath: [DetailRoute] = []
    @State private var accountsPath: [DetailRoute] = []
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack { DashboardView(container: container) }
                .tabItem { Label("Dashboard", systemImage: "rectangle.3.group") }.tag("dashboard")

            NavigationStack(path: $holdingsPath) {
                HoldingsView(container: container)
                    .navigationDestination(for: DetailRoute.self) { detailView(for: $0) }
            }
            .tabItem { Label("Holdings", systemImage: "list.bullet") }.tag("holdings")

            NavigationStack(path: $accountsPath) {
                AccountsView(container: container)
                    .navigationDestination(for: DetailRoute.self) { detailView(for: $0) }
            }
            .tabItem { Label("Accounts", systemImage: "building.columns") }.tag("accounts")

            NavigationStack { AddView(container: container) }
                .tabItem { Label("Add", systemImage: "plus.circle") }.tag("add")

            NavigationStack { SettingsView(container: container) }
                .tabItem { Label("Settings", systemImage: "gearshape") }.tag("settings")
        }
        .onReceive(router.$pending) { route($0) }
        .onAppear { route(router.pending) }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                Task {
                    try? await container.outboxProcessor.drain()
                    try? await container.syncEngine.syncAccounts()
                    try? await container.syncEngine.syncHoldings()
                    try? await container.syncEngine.syncGroups()
                    try? await container.syncEngine.syncVaults()
                }
            }
        }
    }

    @ViewBuilder
    private func detailView(for route: DetailRoute) -> some View {
        switch route {
        case .holding(let id):
            HoldingDetailView(container: container, holdingId: id)
        case .account(let id):
            AccountDetailView(container: container, accountId: id)
        case .group(let id):
            GroupDetailView(container: container, groupId: id)
        case .vault(let id):
            VaultDetailView(container: container, vaultId: id)
        }
    }

    private func route(_ dest: (any Destination)?) {
        guard let dest else { return }
        if let d = dest as? DestinationHolding {
            selection = "holdings"
            holdingsPath = [.holding(d.id)]
        } else if let d = dest as? DestinationAccount {
            selection = "accounts"
            accountsPath = [.account(d.id)]
        } else if let d = dest as? DestinationGroup {
            selection = "accounts"
            accountsPath = [.group(d.id)]
        } else if let d = dest as? DestinationVault {
            selection = "accounts"
            accountsPath = [.vault(d.id)]
        } else if dest is DestinationInstitution {
            selection = "accounts"
        }
        router.pending = nil
    }
}
