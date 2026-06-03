package xyz.scani.mobile.shared.network

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.statement.request
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

fun createScaniHttpClient(
    engine: HttpClientEngine,
    cookieStorage: PersistentCookiesStorage,
    onUnauthorized: () -> Unit,
): HttpClient = HttpClient(engine) {
    expectSuccess = false
    install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    install(HttpCookies) { storage = cookieStorage }
    HttpResponseValidator {
        validateResponse { response ->
            if (response.status == HttpStatusCode.Unauthorized &&
                !response.request.url.encodedPath.contains("/api/auth/")
            ) {
                onUnauthorized()
            }
        }
    }
}
