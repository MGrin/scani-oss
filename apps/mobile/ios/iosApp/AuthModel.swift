import Foundation
import Shared

@MainActor
final class AuthModel: ObservableObject {
    enum Step: Equatable { case enterEmail, enterCode(email: String), authenticated }

    @Published var step: Step
    @Published var busy = false
    @Published var error: String?

    private let repo: AuthRepository

    init(repo: AuthRepository) {
        self.repo = repo
        step = repo.isSignedIn() ? .authenticated : .enterEmail
    }

    func sendCode(email: String) async {
        await run { try await self.repo.requestSignIn(email: email); self.step = .enterCode(email: email) }
    }

    func verify(email: String, code: String) async {
        await run { try await self.repo.completeSignIn(email: email, otp: code); self.step = .authenticated }
    }

    func signOut() {
        repo.signOut()
        step = .enterEmail
    }

    private func run(_ block: @escaping () async throws -> Void) async {
        busy = true; error = nil
        do { try await block() } catch { self.error = error.localizedDescription }
        busy = false
    }
}
