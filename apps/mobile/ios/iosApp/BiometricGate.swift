import LocalAuthentication
import SwiftUI

struct BiometricGate<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @State private var unlocked = false

    var body: some View {
        Group {
            if unlocked {
                content()
            } else {
                VStack(spacing: 16) {
                    Text("Scani is locked")
                    Button("Unlock") { authenticate() }
                }
            }
        }
        .onAppear { authenticate() }
    }

    private func authenticate() {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            // No biometric/passcode enrolled — don't lock the user out.
            unlocked = true
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Scani") { ok, _ in
            if ok { DispatchQueue.main.async { unlocked = true } }
        }
    }
}
