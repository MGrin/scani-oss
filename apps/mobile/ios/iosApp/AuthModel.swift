import Foundation
import Shared

@MainActor
final class AuthModel: ObservableObject {
    enum Step: Equatable { case enterEmail, enterCode(email: String), authenticated }

    @Published var step: Step
    @Published var busy = false
    @Published var error: String?

    private let repo: AuthRepository
    private var unauthorizedObserver: NSObjectProtocol?

    init(repo: AuthRepository) {
        self.repo = repo
        step = repo.isSignedIn() ? .authenticated : .enterEmail
        unauthorizedObserver = NotificationCenter.default.addObserver(
            forName: .scaniUnauthorized, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.step = .enterEmail }
        }
    }

    deinit {
        if let token = unauthorizedObserver { NotificationCenter.default.removeObserver(token) }
    }

    func sendCode(email: String) async {
        await run { try await self.repo.requestSignIn(email: email); self.step = .enterCode(email: email) }
    }

    func verify(email: String, code: String) async {
        await run { try await self.repo.completeSignIn(email: email, otp: code); self.step = .authenticated }
    }

    func signOut() {
        Task { try? await self.repo.signOut() }
        step = .enterEmail
    }

    private func run(_ block: @escaping () async throws -> Void) async {
        busy = true; error = nil
        do { try await block() } catch { self.error = error.localizedDescription }
        busy = false
    }
}
