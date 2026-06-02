package xyz.scani.mobile.android

import android.content.Context
import io.ktor.client.engine.okhttp.OkHttp
import xyz.scani.mobile.android.auth.AndroidSecureStorage
import xyz.scani.mobile.shared.auth.AuthApi
import xyz.scani.mobile.shared.auth.AuthRepository
import xyz.scani.mobile.shared.network.TrpcClient

// Minimal manual DI for the foundation. Per-build-type base URL arrives with the
// build-config milestone; for now a single dev base URL (10.0.2.2 = emulator host loopback).
object ServiceLocator {
    private const val BASE_URL = "http://10.0.2.2:3001"

    lateinit var authRepository: AuthRepository
        private set
    lateinit var trpcClient: TrpcClient
        private set

    fun init(context: Context) {
        if (::authRepository.isInitialized) return
        val engine = OkHttp.create()
        val storage = AndroidSecureStorage(context.applicationContext)
        authRepository = AuthRepository(AuthApi(engine, BASE_URL), storage)
        trpcClient = TrpcClient(
            engine = engine,
            baseUrl = BASE_URL,
            tokenProvider = { authRepository.token() },
            onUnauthorized = { authRepository.signOut() },
        )
    }
}
