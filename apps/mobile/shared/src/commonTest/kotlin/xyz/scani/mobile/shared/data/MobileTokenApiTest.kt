package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MobileTokenApiTest {
    private fun engineFor(vararg pairs: Pair<String, String>) = MockEngine { request ->
        val path = request.url.encodedPath.removePrefix("/trpc/")
        val body = pairs.toMap()[path] ?: error("Unexpected path: $path")
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    @Test
    fun currencies_parses_token_list() = runTest {
        val engine = engineFor(
            "users.getSupportedCurrencies" to """{"result":{"data":[{"id":"usd","symbol":"USD","name":"US Dollar"}]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.currencies()
        assertEquals(1, result.size)
        assertEquals(MobileToken(id = "usd", symbol = "USD", name = "US Dollar"), result[0])
    }

    @Test
    fun searchTokens_returns_both_db_and_external_results_unfiltered() = runTest {
        val metadata = buildJsonObject { put("externalId", "x") }
        val engine = MockEngine { request ->
            val path = request.url.encodedPath.removePrefix("/trpc/")
            val inputParam = request.url.parameters["input"] ?: ""
            assertEquals("tokens.search", path)
            assert(inputParam.contains("btc")) { "Expected input param to contain 'btc', got: $inputParam" }
            respond(
                content = """{"result":{"data":[{"id":"t1","symbol":"BTC","name":"Bitcoin","source":"database"},{"symbol":"X","name":"ExtCoin","provider":"coingecko","metadata":{"externalId":"x"},"source":"external"}]}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.searchTokens("btc")
        assertEquals(2, result.size)
        assertEquals(MobileTokenResult(id = "t1", symbol = "BTC", name = "Bitcoin", provider = null, metadata = null), result[0])
        assertEquals(MobileTokenResult(id = null, symbol = "X", name = "ExtCoin", provider = "coingecko", metadata = metadata), result[1])
        assertNull(result[1].id)
        assertEquals("coingecko", result[1].provider)
        assertEquals(metadata, result[1].metadata)
    }

    @Test
    fun materializeToken_posts_to_createFromExternal_and_returns_MobileToken() = runTest {
        val metadata = buildJsonObject { put("externalId", "x") }
        var capturedMethod: HttpMethod? = null
        var capturedPath = ""
        var capturedBody = ""
        val engine = MockEngine { request ->
            capturedMethod = request.method
            capturedPath = request.url.encodedPath.removePrefix("/trpc/")
            capturedBody = request.body.toByteArray().decodeToString()
            respond(
                content = """{"result":{"data":{"id":"t9","symbol":"X","name":"ExtCoin"}}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.materializeToken("X", "coingecko", metadata)
        assertEquals(HttpMethod.Post, capturedMethod)
        assertEquals("tokens.createFromExternal", capturedPath)
        assert(capturedBody.contains("\"symbol\"")) { "Body missing symbol: $capturedBody" }
        assert(capturedBody.contains("\"provider\"")) { "Body missing provider: $capturedBody" }
        assert(capturedBody.contains("\"metadata\"")) { "Body missing metadata: $capturedBody" }
        assertEquals(MobileToken(id = "t9", symbol = "X", name = "ExtCoin"), result)
    }
}
