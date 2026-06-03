package xyz.scani.mobile.shared.network

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.scani.mobile.shared.data.MobileGroup
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TrpcMutateTest {
    private val input = buildJsonObject {
        put("name", "X")
        put("color", "#112233")
    }

    @Test
    fun mutate_posts_to_trpc_path_with_json_body() = runTest {
        var method: HttpMethod? = null
        var path: String? = null
        var contentType: String? = null
        var body: String? = null

        val engine = MockEngine { request ->
            method = request.method
            path = request.url.encodedPath
            contentType = request.body.contentType?.toString()
            body = request.body.toByteArray().decodeToString()
            respond(
                content = """{"result":{"data":{"id":"g1","name":"X","color":"#112233","description":null}}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }

        val client = TrpcClient(engine, "https://api.test")
        val result = client.mutate<MobileGroup>("mobile.createGroup", input)

        assertEquals(HttpMethod.Post, method)
        assertEquals("/trpc/mobile.createGroup", path)
        assertEquals(ContentType.Application.Json, ContentType.parse(contentType!!))
        assertEquals("""{"name":"X","color":"#112233"}""", body)
        assertEquals(MobileGroup(id = "g1", name = "X", color = "#112233", description = null), result)
    }

    @Test
    fun mutate_fires_onUnauthorized_on_401() = runTest {
        var cleared = false
        val engine = MockEngine {
            respond(
                content = """{"error":{"message":"unauth","code":-32001}}""",
                status = HttpStatusCode.Unauthorized,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(
            engine,
            "https://api.test",
            tokenProvider = { "tok" },
            onUnauthorized = { cleared = true },
        )
        try {
            client.mutate<MobileGroup>("mobile.createGroup", input)
        } catch (_: TrpcException) {}
        assertTrue(cleared)
    }

    @Test
    fun mutate_throws_trpc_exception_on_error_envelope() = runTest {
        val engine = MockEngine {
            respond(
                content = """{"error":{"message":"boom","code":-32600}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(engine, "https://api.test")
        assertFailsWith<TrpcException> { client.mutate<MobileGroup>("mobile.createGroup", input) }
    }
}
