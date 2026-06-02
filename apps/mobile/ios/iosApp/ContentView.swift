import SwiftUI
import Shared

struct ContentView: View {
    @StateObject private var model: AuthModel
    private let container: AppContainer

    init(container: AppContainer) {
        self.container = container
        _model = StateObject(wrappedValue: AuthModel(repo: container.authRepository))
    }

    var body: some View {
        if model.step == .authenticated {
            BiometricGate { MainShell(container: container) }
        } else {
            SignInView(model: model)
        }
    }
}
