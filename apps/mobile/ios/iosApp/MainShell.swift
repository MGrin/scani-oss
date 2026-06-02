import SwiftUI

struct MainShell: View {
    var body: some View {
        TabView {
            tab("Dashboard", "rectangle.3.group")
            tab("Holdings", "list.bullet")
            tab("Accounts", "building.columns")
            tab("Add", "plus.circle")
            tab("Settings", "gearshape")
        }
    }

    private func tab(_ title: String, _ icon: String) -> some View {
        NavigationStack {
            Text(title).navigationTitle(title)
        }
        .tabItem { Label(title, systemImage: icon) }
    }
}
