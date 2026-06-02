import SwiftUI

@main
struct iOSApp: App {
    @StateObject private var container = AppContainer()
    @StateObject private var router = DeepLinkRouter()

    var body: some Scene {
        WindowGroup {
            // ContentView/MainShell will route router.pending to navigation once
            // destination screens land in Milestone 3.
            ContentView(container: container)
                .environmentObject(router)
                .onOpenURL { router.handle($0) }
        }
    }
}
