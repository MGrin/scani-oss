import Foundation
import Shared

// Constructs the shared auth/network stack once. Dev base URL — real per-build
// config is a later milestone.
final class AppContainer: ObservableObject {
    private let baseURL = "http://localhost:3001"
    let authRepository: AuthRepository
    let trpcClient: TrpcClient

    init() {
        let storage = KeychainSecureStorage()
        let engine = HttpEngine_iosKt.defaultHttpEngine()
        let repo = AuthRepository(api: AuthApi(engine: engine, baseUrl: baseURL), storage: storage)
        authRepository = repo
        trpcClient = TrpcClient(
            engine: engine,
            baseUrl: baseURL,
            tokenProvider: { repo.token() },
            onUnauthorized: { repo.signOut() }
        )
    }
}
