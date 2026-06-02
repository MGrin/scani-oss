package xyz.scani.mobile.android

import android.content.Context
import kotlinx.coroutines.Dispatchers
import xyz.scani.mobile.android.auth.AndroidSecureStorage
import xyz.scani.mobile.shared.auth.AuthApi
import xyz.scani.mobile.shared.auth.AuthRepository
import xyz.scani.mobile.shared.data.AccountsRepository
import xyz.scani.mobile.shared.data.HoldingsRepository
import xyz.scani.mobile.shared.data.MobileApi
import xyz.scani.mobile.shared.data.SyncEngine
import xyz.scani.mobile.shared.db.AndroidDriverFactory
import xyz.scani.mobile.shared.db.ScaniDatabase
import xyz.scani.mobile.shared.network.TrpcClient
import xyz.scani.mobile.shared.network.defaultHttpEngine

// Minimal manual DI for the foundation. Per-build-type base URL arrives with the
// build-config milestone; for now a single dev base URL (10.0.2.2 = emulator host loopback).
object ServiceLocator {
    private const val BASE_URL = "http://10.0.2.2:3001"

    lateinit var authRepository: AuthRepository
        private set
    lateinit var trpcClient: TrpcClient
        private set
    lateinit var syncEngine: SyncEngine
        private set
    lateinit var accountsRepository: AccountsRepository
        private set
    lateinit var holdingsRepository: HoldingsRepository
        private set
    var pendingDeepLink: xyz.scani.mobile.shared.navigation.Destination? = null

    fun init(context: Context) {
        if (::authRepository.isInitialized) return
        val engine = defaultHttpEngine()
        val storage = AndroidSecureStorage(context.applicationContext)
        authRepository = AuthRepository(AuthApi(engine, BASE_URL), storage)
        trpcClient = TrpcClient(
            engine = engine,
            baseUrl = BASE_URL,
            tokenProvider = { authRepository.token() },
            onUnauthorized = { authRepository.signOut() },
        )
        val db = ScaniDatabase(AndroidDriverFactory(context.applicationContext).create())
        val api = MobileApi(trpcClient)
        syncEngine = SyncEngine(api, db)
        accountsRepository = AccountsRepository(db, Dispatchers.IO)
        holdingsRepository = HoldingsRepository(db, Dispatchers.IO)
    }
}
