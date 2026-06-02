import Foundation
import Shared

extension Notification.Name {
    static let scaniUnauthorized = Notification.Name("scaniUnauthorized")
}

// Constructs the shared auth/network/data stack once. Dev base URL — real
// per-build config is a later milestone.
final class AppContainer: ObservableObject {
    private let baseURL = "http://localhost:3001"
    let authRepository: AuthRepository
    let trpcClient: TrpcClient
    let syncEngine: SyncEngine
    let accountsRepository: AccountsRepository
    let holdingsRepository: HoldingsRepository
    let syncStateRepository: SyncStateRepository

    init() {
        let storage = KeychainSecureStorage()
        let engine = HttpEngine_iosKt.defaultHttpEngine()
        let repo = AuthRepository(api: AuthApi(engine: engine, baseUrl: baseURL), storage: storage)
        authRepository = repo
        trpcClient = TrpcClient(
            engine: engine,
            baseUrl: baseURL,
            tokenProvider: { repo.token() },
            onUnauthorized: {
                repo.signOut()
                NotificationCenter.default.post(name: .scaniUnauthorized, object: nil)
            }
        )
        let db = ScaniDatabaseCompanion.shared.invoke(driver: NativeDriverFactory().create())
        let api = MobileApi(client: trpcClient)
        syncEngine = SyncEngine(api: api, db: db, now: { KotlinLong(value: Int64(Date().timeIntervalSince1970 * 1000)) })
        accountsRepository = AccountsRepository(db: db, ioContext: Dispatchers_iosKt.iosIoDispatcher())
        holdingsRepository = HoldingsRepository(db: db, ioContext: Dispatchers_iosKt.iosIoDispatcher())
        syncStateRepository = SyncStateRepository(db: db, ioContext: Dispatchers_iosKt.iosIoDispatcher())
    }
}
