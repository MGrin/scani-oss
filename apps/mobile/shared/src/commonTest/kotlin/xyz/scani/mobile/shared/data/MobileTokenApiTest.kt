package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

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
    fun searchTokens_sends_query_param_and_filters_out_id_less_results() = runTest {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath.removePrefix("/trpc/")
            val inputParam = request.url.parameters["input"] ?: ""
            assertEquals("tokens.search", path)
            assert(inputParam.contains("btc")) { "Expected input param to contain 'btc', got: $inputParam" }
            respond(
                content = """{"result":{"data":[{"id":"t1","symbol":"BTC","name":"Bitcoin"},{"symbol":"X","name":"NoId"}]}}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.searchTokens("btc")
        assertEquals(1, result.size)
        assertEquals(MobileToken(id = "t1", symbol = "BTC", name = "Bitcoin"), result[0])
    }
}
