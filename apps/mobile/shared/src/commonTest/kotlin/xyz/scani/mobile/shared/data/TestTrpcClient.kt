package xyz.scani.mobile.shared.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import xyz.scani.trpc.TrpcClient

internal fun mockTrpcClient(engine: HttpClientEngine, baseUrl: String = "https://api.test"): TrpcClient {
    val http = HttpClient(engine) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        expectSuccess = false
    }
    return TrpcClient(http, baseUrl)
}
