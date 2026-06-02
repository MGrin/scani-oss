import SwiftUI
import Shared

struct SignInView: View {
    @ObservedObject var model: AuthModel
    @State private var email = ""
    @State private var code = ""

    var body: some View {
        VStack(spacing: 16) {
            Text("Sign in to Scani").font(.title2)
            switch model.step {
            case .enterEmail, .authenticated:
                TextField("Email", text: $email)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .textFieldStyle(.roundedBorder)
                Button("Send code") {
                    Task { await model.sendCode(email: email.trimmingCharacters(in: .whitespaces)) }
                }
                .disabled(model.busy || email.isEmpty)
            case let .enterCode(email):
                Text("Enter the 6-digit code sent to \(email)")
                TextField("Code", text: $code)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: code) { newValue in code = String(newValue.filter(\.isNumber).prefix(6)) }
                Button("Verify") { Task { await model.verify(email: email, code: code) } }
                    .disabled(model.busy || code.count != 6)
            }
            if model.busy { ProgressView() }
            if let error = model.error { Text(error).foregroundColor(.red) }
        }
        .padding(24)
    }
}
