package xyz.scani.mobile.android

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import xyz.scani.mobile.android.auth.AndroidSecureStorage
import xyz.scani.mobile.android.widget.AndroidWidgetStorage
import xyz.scani.mobile.shared.auth.AuthApi
import xyz.scani.mobile.shared.auth.AuthRepository
import xyz.scani.mobile.shared.data.AccountsRepository
import xyz.scani.mobile.shared.data.GroupsRepository
import xyz.scani.mobile.shared.data.HoldingsRepository
import xyz.scani.mobile.shared.data.MobileApi
import xyz.scani.mobile.shared.data.OutboxProcessor
import xyz.scani.mobile.shared.data.OutboxRepository
import xyz.scani.mobile.shared.data.ScreenshotUploadService
import xyz.scani.mobile.shared.data.SyncEngine
import xyz.scani.mobile.shared.data.SyncStateRepository
import xyz.scani.mobile.shared.data.VaultsRepository
import xyz.scani.mobile.shared.data.WidgetSnapshotWriter
import xyz.scani.mobile.shared.data.WriteQueue
import xyz.scani.mobile.shared.db.AndroidDriverFactory
import xyz.scani.mobile.shared.db.ScaniDatabase
import xyz.scani.mobile.shared.network.PersistentCookiesStorage
import xyz.scani.mobile.shared.network.createScaniHttpClient
import xyz.scani.mobile.shared.network.defaultHttpEngine
import xyz.scani.trpc.TrpcClient

object ServiceLocator {
    private const val BASE_URL = "http://10.0.2.2:3001"

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var authRepository: AuthRepository
        private set
    lateinit var trpcClient: TrpcClient
        private set
    lateinit var mobileApi: MobileApi
        private set
    lateinit var syncEngine: SyncEngine
        private set
    lateinit var accountsRepository: AccountsRepository
        private set
    lateinit var holdingsRepository: HoldingsRepository
        private set
    lateinit var syncStateRepository: SyncStateRepository
        private set
    lateinit var outboxRepository: OutboxRepository
        private set
    lateinit var writeQueue: WriteQueue
        private set
    lateinit var outboxProcessor: OutboxProcessor
        private set
    lateinit var groupsRepository: GroupsRepository
        private set
    lateinit var vaultsRepository: VaultsRepository
        private set
    lateinit var screenshotUploadService: ScreenshotUploadService
        private set
    lateinit var widgetSnapshotWriter: WidgetSnapshotWriter
        private set
    var pendingDeepLink: xyz.scani.mobile.shared.navigation.Destination? = null

    fun init(context: Context) {
        if (::authRepository.isInitialized) return
        val storage = AndroidSecureStorage(context.applicationContext)
        val cookieJar = PersistentCookiesStorage(storage)
        val http = createScaniHttpClient(defaultHttpEngine(), cookieJar) { authRepository.onUnauthorized() }
        authRepository = AuthRepository(AuthApi(http, BASE_URL), cookieJar)
        trpcClient = TrpcClient(http, BASE_URL)
        val db = ScaniDatabase(AndroidDriverFactory(context.applicationContext).create())
        mobileApi = MobileApi(trpcClient)
        syncEngine = SyncEngine(mobileApi, db)
        accountsRepository = AccountsRepository(db, Dispatchers.IO)
        holdingsRepository = HoldingsRepository(db, Dispatchers.IO)
        syncStateRepository = SyncStateRepository(db, Dispatchers.IO)
        outboxRepository = OutboxRepository(db, Dispatchers.IO)
        writeQueue = WriteQueue(db, outboxRepository)
        outboxProcessor = OutboxProcessor(trpcClient, outboxRepository, syncEngine)
        groupsRepository = GroupsRepository(db, Dispatchers.IO)
        vaultsRepository = VaultsRepository(db, Dispatchers.IO)
        screenshotUploadService = ScreenshotUploadService(http, trpcClient)
        widgetSnapshotWriter = WidgetSnapshotWriter(
            accountsRepository,
            holdingsRepository,
            groupsRepository,
            vaultsRepository,
            AndroidWidgetStorage(context.applicationContext),
        )
        val cm = context.getSystemService(android.net.ConnectivityManager::class.java)
        cm?.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) {
                appScope.launch { runCatching { outboxProcessor.drain() } }
            }
        })
    }
}
