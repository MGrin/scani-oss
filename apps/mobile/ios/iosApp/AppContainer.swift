import Foundation
import Network
import Shared

extension Notification.Name {
    static let scaniUnauthorized = Notification.Name("scaniUnauthorized")
}

final class AppContainer: ObservableObject {
    private let baseURL = "http://localhost:3001"
    let authRepository: AuthRepository
    let trpcClient: TrpcClient
    let syncEngine: SyncEngine
    let accountsRepository: AccountsRepository
    let holdingsRepository: HoldingsRepository
    let syncStateRepository: SyncStateRepository
    let outboxRepository: OutboxRepository
    let writeQueue: WriteQueue
    let outboxProcessor: OutboxProcessor
    let groupsRepository: GroupsRepository
    let vaultsRepository: VaultsRepository
    let mobileApi: MobileApi
    private let pathMonitor = NWPathMonitor()

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
        let io = Dispatchers_iosKt.iosIoDispatcher()
        let api = MobileApi(client: trpcClient)
        mobileApi = api
        syncEngine = SyncEngine(api: api, db: db, now: { KotlinLong(value: Int64(Date().timeIntervalSince1970 * 1000)) })
        accountsRepository = AccountsRepository(db: db, ioContext: io)
        holdingsRepository = HoldingsRepository(db: db, ioContext: io)
        syncStateRepository = SyncStateRepository(db: db, ioContext: io)
        let outbox = OutboxRepository(db: db, ioContext: io)
        outboxRepository = outbox
        writeQueue = WriteQueue(
            db: db,
            outbox: outbox,
            genId: { UUID().uuidString },
            now: { KotlinLong(value: Int64(Date().timeIntervalSince1970 * 1000)) }
        )
        let processor = OutboxProcessor(client: trpcClient, outbox: outbox, syncEngine: syncEngine)
        outboxProcessor = processor
        groupsRepository = GroupsRepository(db: db, ioContext: io)
        vaultsRepository = VaultsRepository(db: db, ioContext: io)

        pathMonitor.pathUpdateHandler = { path in
            guard path.status == .satisfied else { return }
            Task { try? await processor.drain() }
        }
        pathMonitor.start(queue: DispatchQueue(label: "connectivity"))
    }
}
