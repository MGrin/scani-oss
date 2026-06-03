package xyz.scani.trpc

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.content.TextContent
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

class TrpcClient(
    @PublishedApi internal val http: HttpClient,
    baseUrl: String,
) {
    @PublishedApi internal val baseUrl: String = baseUrl.trimEnd('/')
    @PublishedApi internal val json: Json = Json { ignoreUnknownKeys = true }

    suspend inline fun <reified T> query(path: String, input: JsonElement? = null): T {
        val response = http.get("$baseUrl/trpc/$path") {
            if (input != null) parameter("input", json.encodeToString(input))
        }
        val envelope = response.body<TrpcEnvelope<T>>()
        envelope.error?.let { throw TrpcException(it.message ?: "tRPC error: $path", it) }
        return envelope.result?.data ?: throw TrpcException("Empty tRPC result: $path", null)
    }

    suspend inline fun <reified T> mutate(path: String, input: JsonElement): T {
        val response = http.post("$baseUrl/trpc/$path") {
            setBody(TextContent(json.encodeToString(input), ContentType.Application.Json))
        }
        val envelope = response.body<TrpcEnvelope<T>>()
        envelope.error?.let { throw TrpcException(it.message ?: "tRPC error: $path", it) }
        return envelope.result?.data ?: throw TrpcException("Empty tRPC result: $path", null)
    }
}
