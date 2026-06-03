import Combine
import SwiftUI
import Shared

struct MainShell: View {
    let container: AppContainer
    @EnvironmentObject private var router: DeepLinkRouter
    @State private var selection = "dashboard"
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack { DashboardView(container: container) }
                .tabItem { Label("Dashboard", systemImage: "rectangle.3.group") }.tag("dashboard")
            NavigationStack { HoldingsView(container: container) }
                .tabItem { Label("Holdings", systemImage: "list.bullet") }.tag("holdings")
            NavigationStack { AccountsView(container: container) }
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

    // Detail-destination routing (Holding(id)/Account(id) → detail view) is a
    // later milestone; for now map to the owning tab and clear.
    private func route(_ dest: (any Destination)?) {
        guard let dest else { return }
        if dest is DestinationHolding { selection = "holdings" }
        else if dest is DestinationAccount || dest is DestinationInstitution { selection = "accounts" }
        router.pending = nil
    }
}
