package xyz.scani.mobile.shared.network

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@Serializable
private data class Probe(val value: String)

class TrpcClientTest {
    private fun jsonEngine(body: String) = MockEngine {
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    @Test
    fun query_unwraps_result_data_and_hits_trpc_path() = runTest {
        var requestedPath: String? = null
        val engine = MockEngine { request ->
            requestedPath = request.url.encodedPath
            respond(
                content = """{"result":{"data":{"value":"hello"}}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(engine, "https://api.test")
        val result = client.query<Probe>("probe.get")
        assertEquals(Probe("hello"), result)
        assertEquals("/trpc/probe.get", requestedPath)
    }

    @Test
    fun query_throws_on_error_envelope() = runTest {
        val client = TrpcClient(jsonEngine("""{"error":{"message":"boom","code":-32600}}"""), "https://api.test")
        assertFailsWith<TrpcException> { client.query<Probe>("probe.get") }
    }

    @Test
    fun query_throws_trpc_exception_on_non_2xx_error() = runTest {
        val engine = MockEngine {
            respond(
                content = """{"error":{"message":"unauthorized","code":-32001}}""",
                status = HttpStatusCode.Unauthorized,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(engine, "https://api.test")
        assertFailsWith<TrpcException> { client.query<Probe>("probe.get") }
    }

    @Test
    fun query_throws_when_result_and_error_both_absent() = runTest {
        val client = TrpcClient(jsonEngine("""{}"""), "https://api.test")
        assertFailsWith<TrpcException> { client.query<Probe>("probe.get") }
    }

    @Test
    fun query_trims_trailing_slash_in_base_url() = runTest {
        var requestedPath: String? = null
        val engine = MockEngine { request ->
            requestedPath = request.url.encodedPath
            respond(
                content = """{"result":{"data":{"value":"x"}}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(engine, "https://api.test/")
        client.query<Probe>("probe.get")
        assertEquals("/trpc/probe.get", requestedPath)
    }

    @Test
    fun query_attaches_bearer_token_when_provided() = runTest {
        var authHeader: String? = null
        val engine = MockEngine { request ->
            authHeader = request.headers["Authorization"]
            respond(
                content = """{"result":{"data":{"value":"ok"}}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(engine, "https://api.test", tokenProvider = { "tok123" })
        client.query<Probe>("probe.get")
        assertEquals("Bearer tok123", authHeader)
    }

    @Test
    fun unauthorized_response_triggers_onUnauthorized_and_throws() = runTest {
        var cleared = false
        val engine = MockEngine {
            respond(
                content = """{"error":{"message":"unauth","code":-32001}}""",
                status = HttpStatusCode.Unauthorized,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = TrpcClient(engine, "https://api.test", tokenProvider = { "tok" }, onUnauthorized = { cleared = true })
        assertFailsWith<TrpcException> { client.query<Probe>("probe.get") }
        assertTrue(cleared)
    }
}
