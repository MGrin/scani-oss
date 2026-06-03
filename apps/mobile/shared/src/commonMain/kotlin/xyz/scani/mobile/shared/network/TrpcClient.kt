package xyz.scani.mobile.shared.network

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Minimal tRPC-over-HTTP client. The HTTP engine is injected so platform apps
 * supply Darwin/OkHttp while tests supply MockEngine.
 */
class TrpcClient(
    engine: HttpClientEngine,
    baseUrl: String,
    @PublishedApi internal val tokenProvider: () -> String? = { null },
    @PublishedApi internal val onUnauthorized: () -> Unit = {},
) {
    @PublishedApi
    internal val baseUrl: String = baseUrl.trimEnd('/')

    @PublishedApi
    internal val json = Json { ignoreUnknownKeys = true }

    @PublishedApi
    internal val http = HttpClient(engine) {
        install(ContentNegotiation) { json(json) }
        // tRPC returns 4xx/5xx WITH a {error} body for procedure errors; let the
        // envelope parser surface it as TrpcException instead of a raw Ktor throw.
        expectSuccess = false
    }

    suspend inline fun <reified T> query(procedure: String, input: JsonElement? = null): T {
        val response = http.get("$baseUrl/trpc/$procedure") {
            tokenProvider()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
            if (input != null) parameter("input", json.encodeToString(input))
        }
        if (response.status == HttpStatusCode.Unauthorized) {
            onUnauthorized()
        }
        val envelope = response.body<TrpcEnvelope<T>>()
        envelope.error?.let { throw TrpcException(it.message ?: "tRPC error: $procedure", it) }
        return envelope.result?.data ?: throw TrpcException("Empty tRPC result: $procedure", null)
    }

    suspend inline fun <reified T> mutate(procedure: String, input: JsonElement): T {
        val response = http.post("$baseUrl/trpc/$procedure") {
            tokenProvider()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
            setBody(TextContent(json.encodeToString(input), ContentType.Application.Json))
        }
        if (response.status == HttpStatusCode.Unauthorized) onUnauthorized()
        val envelope = response.body<TrpcEnvelope<T>>()
        envelope.error?.let { throw TrpcException(it.message ?: "tRPC error: $procedure", it) }
        return envelope.result?.data ?: throw TrpcException("Empty tRPC result: $procedure", null)
    }
}
