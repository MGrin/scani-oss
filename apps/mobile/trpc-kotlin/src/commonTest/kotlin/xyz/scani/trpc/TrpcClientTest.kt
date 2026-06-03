package xyz.scani.trpc

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@Serializable
private data class Item(val id: String, val name: String)

private fun clientReturning(
    status: HttpStatusCode,
    body: String,
    capture: ((HttpRequestData) -> Unit)? = null,
): TrpcClient {
    val engine = MockEngine { req ->
        capture?.invoke(req)
        respond(
            content = ByteReadChannel(body),
            status = status,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }
    val http = HttpClient(engine) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        expectSuccess = false
    }
    return TrpcClient(http, "https://api.test")
}

class TrpcClientTest {
    @Test
    fun query_gets_trpc_path_and_unwraps_data() = runTest {
        var method: HttpMethod? = null
        var url: String? = null
        val client = clientReturning(
            HttpStatusCode.OK, """{"result":{"data":[{"id":"a","name":"X"}]}}""",
        ) { req -> method = req.method; url = req.url.toString() }
        val items: List<Item> = client.query("accounts.getAll")
        assertEquals(HttpMethod.Get, method)
        assertTrue(url!!.contains("/trpc/accounts.getAll"))
        assertEquals(listOf(Item("a", "X")), items)
    }

    @Test
    fun query_encodes_input_as_query_param() = runTest {
        var url: String? = null
        val client = clientReturning(HttpStatusCode.OK, """{"result":{"data":[]}}""") { req -> url = req.url.toString() }
        client.query<List<Item>>("tokens.search", buildJsonObject { put("query", "btc") })
        assertTrue(url!!.contains("input="))
    }

    @Test
    fun mutate_posts_body_and_unwraps_data() = runTest {
        var method: HttpMethod? = null
        val client = clientReturning(HttpStatusCode.OK, """{"result":{"data":{"id":"a","name":"X"}}}""") { req -> method = req.method }
        val item: Item = client.mutate("accounts.update", buildJsonObject { put("id", "a") })
        assertEquals(HttpMethod.Post, method)
        assertEquals(Item("a", "X"), item)
    }

    @Test
    fun error_envelope_throws_trpc_exception() = runTest {
        val client = clientReturning(HttpStatusCode.OK, """{"error":{"message":"nope","code":-32001}}""")
        val ex = assertFailsWith<TrpcException> { client.query<List<Item>>("x.y") }
        assertEquals("nope", ex.message)
    }
}
